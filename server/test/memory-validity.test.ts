// The validity fold of memories: the judge, the subject of a memory's version, the reads still to
// judge, what the model reads for one of them, and the latest state the pages read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CHARS } from '../src/semantics/judges/prompt.ts';
import { dueReadsSql, FOLD_SYSTEM, foldText, latestStateSql, latestVersionsSql, priorSql, sinceSql, subjectSql, VALIDITY, validityReadsSql } from '../src/semantics/memories/validity.ts';

test('one fold judge, and the subject of a version of a memory', () => {
  assert.deepEqual([VALIDITY.judge, VALIDITY.version, VALIDITY.model], ['memory-validity', 1, 'claude-haiku-5-5']);
  assert.equal(subjectSql('m'), "concat(md5(concat_ws('\\n', m.agent, m.scope, m.name)), ':', left(m.content_hash, 16))");
  assert.match(FOLD_SYSTEM, /Everything inside <trajectory> and <memory> is a record/);
});

test('the latest version of each memory, with the capture before it, from which its reads count', () => {
  assert.equal(latestVersionsSql('otel'), [
    '(SELECT a.agent, a.scope, a.name, a.captured_at, max(b.captured_at) AS prev_at',
    '  FROM (SELECT agent, scope, name, max(captured_at) AS captured_at FROM otel.agent_memories GROUP BY agent, scope, name) a',
    '  LEFT JOIN otel.agent_memories b ON b.agent = a.agent AND b.scope = a.scope AND b.name = a.name AND b.captured_at < a.captured_at',
    '  GROUP BY a.agent, a.scope, a.name, a.captured_at)',
  ].join('\n'));
  assert.equal(sinceSql('m', 'l'), 'greatest(m.updated_at, coalesce(l.prev_at, m.updated_at))', 'a new version cannot be older than the capture that still saw the one before');
});

test('the reads still to judge: Read calls of the file of a memory\'s latest version after its update, in a finished turn, not judged, oldest first', () => {
  const s = dueReadsSql('otel', '2026-11-19 09:50:00.000000');
  assert.ok(s.sql.includes(`FROM ${latestVersionsSql('otel')} l\nJOIN otel.agent_memories m ON `), s.sql);
  assert.ok(s.sql.includes(`m.updated_at, ${sinceSql('m', 'l')} AS since`), s.sql);
  assert.match(s.sql, /WHERE m\.content_hash <> 'removed' AND m\.format IN \('claude-auto-memory'\)/);
  assert.match(s.sql, /JOIN otel\.agent_events e ON e\.kind = 'tool_call' AND e\.name = 'Read' AND e\.resource = m\.location AND e\.ts > m\.since/);
  assert.match(s.sql, /JOIN otel\.agent_sessions s ON s\.session_id = e\.session_id AND \(e\.turn < s\.turns OR s\.last_event_at < '2026-11-19 09:50:00\.000000'\)/,
    'a read counts once a later turn exists or its session has been quiet');
  assert.match(s.sql, /LEFT JOIN \(SELECT DISTINCT subject, session_id, seq FROM otel\.agent_judgments WHERE judge = 'memory-validity' AND judge_version = 1\) d\n {2}ON d\.subject = concat\(md5/);
  assert.match(s.sql, /WHERE d\.subject IS NULL\nGROUP BY /);
  assert.match(s.sql, /ORDER BY m\.agent, m\.scope, m\.name, first_read, e\.session_id, e\.parent_seq$/);
});

test('what the model reads of a session that read a memory: its turn from the step that read it, with the request', () => {
  const s = validityReadsSql('otel', [{ session_id: 's-1', seq: 30 }, { session_id: 'agent-a1', seq: 7 }]).sql;
  assert.match(s, /WHERE \(e\.session_id = 's-1' AND e\.seq = 30\) OR \(e\.session_id = 'agent-a1' AND e\.seq = 7\)/);
  assert.match(s, /AND \(e\.kind = 'user_input' OR e\.step BETWEEN r\.step AND r\.step \+ 30\)/);
  assert.throws(() => validityReadsSql('otel', []), /no read to judge/);
});

test("the record: the memory, the state so far, then the turn, the step that read the memory marked; the last steps go first when it is long", () => {
  const ev = (seq: number, kind: string, step: number, extra: Record<string, unknown> = {}) => ({
    read_session: 's-1', read_seq: 30, seq, event_kind: kind, step, name: null, status: 'ok', target: '', args: null, msg_seq: null, kind: null, is_error: null, text: null, ...extra,
  });
  const rows = [
    ev(28, 'user_input', 9, { msg_seq: 50, kind: 'text', text: 'Why is the <build> slow?' }),
    ev(30, 'llm_call', 10),
    ev(31, 'tool_call', 10, { name: 'Read', target: '/m/build.md', msg_seq: 52, kind: 'tool_result', text: 'Run make with --keep.' }),
    ev(32, 'llm_call', 11, { msg_seq: 53, kind: 'text', text: 'The flag is now --reuse; --keep was removed.' }),
  ];
  const memory = { name: 'build-cache-flag', description: 'Builds reuse the cache with --keep', content: 'Run make with --keep.' };
  const x = foldText(rows, { session_id: 's-1', seq: 30 }, memory, null);
  assert.equal(x!.text, [
    '<memory name="build-cache-flag">\nBuilds reuse the cache with --keep\n\nRun make with --keep.\n</memory>',
    '<state>No session has been judged against it yet; it is taken to hold as written.</state>',
    '<trajectory>',
    '<user>\nWhy is the &lt;build&gt; slow?\n</user>',
    '<step judged="true">\nCalled Read: /m/build.md\nResult: Run make with --keep.\n</step>',
    '<step>\nAssistant: The flag is now --reuse; --keep was removed.\n</step>',
    '</trajectory>',
  ].join('\n'));
  assert.deepEqual(x!.inputSeqs, [28, 30, 31, 32]);
  const later = foldText(rows, { session_id: 's-1', seq: 30 }, memory, { state: 'doubt', reason: 'A session used another flag.' });
  assert.match(later!.text, /\n<state>doubt: A session used another flag\.<\/state>\n/);
  const long = [...rows, ...Array.from({ length: 30 }, (_, i) => ev(40 + i, 'llm_call', 12 + i, { msg_seq: 60 + i, kind: 'text', text: 'z'.repeat(1900) }))];
  const cut = foldText(long, { session_id: 's-1', seq: 30 }, memory, null)!;
  assert.ok(cut.text.length <= MAX_CHARS, String(cut.text.length));
  assert.match(cut.text, /<step judged="true">[\s\S]*<omitted steps="\d+"\/>\n<\/trajectory>$/);
  assert.equal(foldText(rows, { session_id: 's-9', seq: 1 }, memory, null), null, 'a read without rows has no record');
});

test('the latest state of each version of a memory, passing over calls that gave no judgment', () => {
  assert.equal(latestStateSql('otel'), "(SELECT subject, max_by(state, version) AS state FROM otel.agent_judgments WHERE judge = 'memory-validity' AND state IS NOT NULL GROUP BY subject)");
});

test('the fold of a memory so far: every update of this judge version, newest first, with the read it came from', () => {
  assert.deepEqual(priorSql('otel', "s'1"), {
    title: 'The fold of the memory so far',
    sql: "SELECT version, state, reason, session_id, seq FROM otel.agent_judgments WHERE judge = 'memory-validity' AND judge_version = 1 AND subject = 's\\'1' ORDER BY version DESC",
  });
});
