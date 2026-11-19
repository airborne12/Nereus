// The statements of the Judges pages: the counts of every judge, and the verdicts of one as
// "first violation in each session", "all verdicts" or "changed by a rerun".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgesSql, verdictSql, verdictsSql } from '../src/semantics/judges/views.ts';

test('the list counts each judge from the latest verdict of each step, against its current version', () => {
  const s = judgesSql('otel', [{ id: 'edits-a1', currentVersion: 2 }, { id: "o'k-b2", currentVersion: 1 }])!;
  assert.match(s.sql, /FROM otel\.agent_judgments\n {2}WHERE judge IN \('edits-a1', 'o\\'k-b2'\)\n {2}GROUP BY judge, session_id, seq/);
  assert.match(s.sql, /sum\(if\(made_by < CASE judge WHEN 'edits-a1' THEN 2 WHEN 'o\\'k-b2' THEN 1 END, 1, 0\)\) AS stale/);
  assert.match(s.sql, /max\(at\) AS last_judged\nFROM latest\nGROUP BY judge$/);
  assert.equal(judgesSql('otel', []), null, 'no judge, no statement');
});

test('all verdicts: the latest of each step, newest step first, with the step and its calls', () => {
  const s = verdictsSql('otel', 'edits-a1', 2, 'all').sql;
  assert.match(s, /^WITH latest AS \(\n {2}SELECT session_id, seq, max\(judge_version\) AS made_by, max_by\(verdict, judge_version\) AS verdict, max_by\(reason, judge_version\) AS reason\n/);
  assert.match(s, /picked AS \(\n {2}SELECT l\.\*, NULL AS violations, NULL AS was, NULL AS was_version FROM latest l\n\)/);
  assert.match(s, /SELECT e\.ts, p\.session_id, p\.seq, e\.turn, e\.step, s\.title, s\.root_id, t\.calls, p\.verdict, p\.made_by, p\.made_by < 2 AS stale, p\.reason, p\.violations, p\.was, p\.was_version/);
  assert.match(s, /JOIN otel\.agent_events e ON e\.session_id = p\.session_id AND e\.seq = p\.seq AND e\.kind = 'llm_call'\nLEFT JOIN otel\.agent_sessions s ON s\.session_id = p\.session_id\nLEFT JOIN tools_of t ON t\.session_id = p\.session_id AND t\.seq = p\.seq/);
  assert.match(s, /group_concat\(concat\(c\.name, ' ', left\(coalesce\(c\.resource, CAST\(c\.args AS STRING\), ''\), 80\)\), ', '\) AS calls/);
  assert.match(s, /ORDER BY e\.ts DESC, p\.session_id, p\.seq\nLIMIT 500$/);
});

test('the first violation in each session, with how many steps of it violate', () => {
  const s = verdictsSql('otel', 'edits-a1', 2, 'first').sql;
  assert.match(s, /row_number\(\) OVER \(PARTITION BY l\.session_id ORDER BY l\.seq\) AS rn, count\(\*\) OVER \(PARTITION BY l\.session_id\) AS violations/);
  assert.match(s, /WHERE l\.verdict = 'violates'\n\),\npicked AS \(\n {2}SELECT session_id, seq, made_by, verdict, reason, violations, NULL AS was, NULL AS was_version FROM marked WHERE rn = 1\n\)/);
});

test('changed by a rerun: steps whose latest verdict differs from the one before it', () => {
  const s = verdictsSql('otel', 'edits-a1', 2, 'changed').sql;
  assert.match(s, /lag\(verdict\) OVER \(PARTITION BY session_id, seq ORDER BY judge_version\) AS was,\n {9}lag\(judge_version\) OVER \(PARTITION BY session_id, seq ORDER BY judge_version\) AS was_version,\n {9}row_number\(\) OVER \(PARTITION BY session_id, seq ORDER BY judge_version DESC\) AS rn/);
  assert.match(s, /SELECT session_id, seq, judge_version AS made_by, verdict, reason, NULL AS violations, was, was_version FROM marked WHERE rn = 1 AND was IS NOT NULL AND was <> verdict/);
});

test('every verdict of one step, newest version first', () => {
  assert.equal(verdictSql('otel', 'edits-a1', 's-1', 21).sql,
    "SELECT judge_version, verdict, reason, model, input_seqs, input_tokens, output_tokens, judged_at\nFROM otel.agent_judgments\nWHERE judge = 'edits-a1' AND session_id = 's-1' AND seq = 21\nORDER BY judge_version DESC");
  assert.throws(() => verdictSql('otel', 'j', "x' --", 1), /bad session id/);
});
