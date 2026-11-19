// The statements of a judge: the steps it picks, the steps a run sends to the model, what the model
// reads for each, and the lineage of the stored verdicts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pick } from '../src/semantics/judges/judge.ts';
import { countSql, latestCte, lineageSql, pickedCte, readsSql, sampleSql, subjectsSql } from '../src/semantics/judges/statements.ts';

const TESTS: Pick = { tool: 'change', has: 'tests/ | spec', status: 'any' };

test('a judge picks the model calls that made a call meeting its pick', () => {
  const cte = pickedCte('otel', TESTS);
  assert.equal(cte, [
    'picked AS (',
    '  SELECT c.session_id, c.parent_seq AS seq, min(s.ts) AS ts, min(s.turn) AS turn, min(s.step) AS step',
    '  FROM otel.agent_events c',
    "  JOIN otel.agent_events s ON s.session_id = c.session_id AND s.seq = c.parent_seq AND s.kind = 'llm_call'",
    "  WHERE c.kind = 'tool_call' AND c.name IN ('Edit', 'Write')",
    "    AND (instr(lower(coalesce(c.resource, CAST(c.args AS STRING), '')), 'tests/') > 0 OR instr(lower(coalesce(c.resource, CAST(c.args AS STRING), '')), 'spec') > 0)",
    '  GROUP BY c.session_id, c.parent_seq',
    ')',
  ].join('\n'));
  assert.match(pickedCte('otel', { tool: 'Bash', has: '', status: 'error' }), /WHERE c\.kind = 'tool_call' AND c\.name = 'Bash' AND c\.status = 'error'\n {2}GROUP BY/);
  assert.match(pickedCte('otel', { tool: 'any', has: "o'k", status: 'ok' }), /WHERE c\.kind = 'tool_call' AND c\.status = 'ok'\n {4}AND \(instr\(.*, 'o\\'k'\) > 0\)/);
});

test('the count of picked steps and a sample spread over them, newest first', () => {
  assert.equal(countSql('otel', TESTS).sql, `WITH ${pickedCte('otel', TESTS)}\nSELECT count(*) AS steps, count(DISTINCT session_id) AS sessions FROM picked`);
  const s = sampleSql('otel', TESTS).sql;
  assert.match(s, /ranked AS \(\n {2}SELECT p\.\*, row_number\(\) OVER \(ORDER BY p\.ts DESC, p\.session_id, p\.seq\) - 1 AS i, count\(\*\) OVER \(\) AS n\n {2}FROM picked p\n\)/);
  assert.match(s, /WHERE n <= 5 OR i IN \(0, n DIV 5, \(2 \* n\) DIV 5, \(3 \* n\) DIV 5, \(4 \* n\) DIV 5\)\nORDER BY i$/);
});

const V = { judge: 'edits-1a2b3c', version: 3, pick: TESTS };

test('a run sends the picked steps without a verdict of its version, oldest first', () => {
  const s = subjectsSql('otel', V, 'picked').sql;
  assert.match(s, /LEFT JOIN \(SELECT DISTINCT session_id, seq FROM otel\.agent_judgments WHERE judge = 'edits-1a2b3c' AND judge_version = 3\) d ON d\.session_id = p\.session_id AND d\.seq = p\.seq\nWHERE d\.seq IS NULL\nORDER BY p\.ts, p\.session_id, p\.seq$/);
  // New sessions: the picked steps without any verdict of the judge.
  assert.match(subjectsSql('otel', V, 'new').sql, /WHERE judge = 'edits-1a2b3c'\) d ON/);
  // A rerun: the steps whose latest verdict an older version made; or only the violating ones.
  const stale = subjectsSql('otel', V, 'stale').sql;
  assert.ok(stale.includes(latestCte('otel', V.judge)));
  assert.match(stale, /JOIN latest l ON l\.session_id = p\.session_id AND l\.seq = p\.seq\nWHERE l\.made_by < 3\nORDER BY/);
  assert.match(subjectsSql('otel', V, 'stale-violating').sql, /WHERE l\.made_by < 3 AND l\.verdict = 'violates'\n/);
});

test('the latest verdict of each step and the counts of a judge', () => {
  assert.equal(latestCte('otel', 'j1'), [
    'latest AS (',
    '  SELECT session_id, seq, max(judge_version) AS made_by, max_by(verdict, judge_version) AS verdict',
    '  FROM otel.agent_judgments',
    "  WHERE judge = 'j1'",
    '  GROUP BY session_id, seq',
    ')',
  ].join('\n'));
  assert.equal(lineageSql('otel', 'j1', 2).sql, [
    `WITH ${latestCte('otel', 'j1')},`,
    'spent AS (',
    "  SELECT round(avg(input_tokens)) AS per_step FROM otel.agent_judgments WHERE judge = 'j1' AND input_tokens > 0",
    ')',
    "SELECT count(*) AS judged, sum(if(verdict = 'violates', 1, 0)) AS violations,",
    "       count(DISTINCT if(verdict = 'violates', session_id, NULL)) AS sessions,",
    "       sum(if(made_by < 2, 1, 0)) AS stale, sum(if(made_by < 2 AND verdict = 'violates', 1, 0)) AS stale_violating,",
    '       max(spent.per_step) AS tokens_per_step',
    'FROM latest, spent',
  ].join('\n'));
});

test('what the model reads: the request of the turn and the steps near the judged one, with their text', () => {
  const steps = [{ session_id: 's-1', seq: 21 }, { session_id: 's-2', seq: 7 }];
  const s = readsSql('otel', { kind: 'before', n: 3 }, steps).sql;
  assert.match(s, /WHERE j\.kind = 'llm_call' AND \(\(j\.session_id = 's-1' AND j\.seq = 21\) OR \(j\.session_id = 's-2' AND j\.seq = 7\)\)/);
  assert.match(s, /JOIN otel\.agent_events e ON e\.session_id = j\.session_id AND e\.turn = j\.turn\n {2}WHERE e\.kind = 'user_input' OR \(e\.kind IN \('llm_call', 'tool_call'\) AND e\.step BETWEEN j\.step - 3 AND j\.step\)/);
  assert.match(s, /LEFT JOIN otel\.agent_messages m ON m\.session_id = r\.session_id AND m\.event_seq = r\.seq AND m\.kind IN \('text', 'tool_result'\)/);
  assert.match(s, /left\(m\.text, 2000\) AS text/);
  assert.match(s, /ORDER BY r\.session_id, r\.judged, r\.seq, m\.msg_seq$/);
  assert.match(readsSql('otel', { kind: 'step' }, steps).sql, /AND e\.step = j\.step\)/);
  assert.match(readsSql('otel', { kind: 'turn' }, steps).sql, /AND e\.step BETWEEN j\.step - 30 AND j\.step\)/);
  assert.throws(() => readsSql('otel', { kind: 'step' }, []), /no step to read/);
  assert.throws(() => readsSql('otel', { kind: 'step' }, [{ session_id: "x' OR 1=1", seq: 1 }]), /bad session id/);
  assert.throws(() => readsSql('otel', { kind: 'step' }, [{ session_id: 's', seq: 1.5 }]), /seq must be a whole number/);
});
