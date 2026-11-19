// The SQL a sequence pattern compiles to: one level per step, a window for "any later event",
// a join on the target for "the same target", and nothing from a request that is not a literal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionScope } from '../src/semantics/sequences/events.ts';
import { matchSql, type MatchRequest, patternCtes } from '../src/semantics/sequences/match.ts';
import { parsePattern } from '../src/semantics/sequences/pattern.ts';

const req = (pattern: unknown, extra: Partial<MatchRequest> = {}): MatchRequest =>
  ({ from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z', pattern: parsePattern(pattern), limit: 100, offset: 0, ...extra });

test('the next event is a join on the position after', () => {
  const { rows, total } = matchSql('otel', req([{ tool: 'Edit' }, { tool: 'Bash', status: 'failed', has: 'Test', link: 'next' }]));
  assert.match(rows.sql, /^WITH events AS \(/);
  assert.match(rows.sql, /FROM otel\.agent_events e\n {2}WHERE /);
  assert.match(rows.sql, /e\.ts >= '2026-11-17 00:00:00\.000' AND e\.ts < '2026-11-18 00:00:00\.000'/);
  assert.match(rows.sql, /m1 AS \(\n {2}SELECT a\.session_id, a\.pos AS pos1\n {2}FROM events a\n {2}WHERE a\.kind = 'tool_call' AND a\.what = 'Edit'\n\)/);
  assert.match(rows.sql, /JOIN events c ON c\.session_id = m\.session_id AND c\.pos = m\.pos1 \+ 1\n {2}WHERE c\.kind = 'tool_call' AND c\.what = 'Bash' AND c\.status = 'error' AND instr\(lower\(c\.target\), 'test'\) > 0/);
  assert.doesNotMatch(rows.sql, /texts AS|OVER \(PARTITION BY b\.session_id/);
  assert.match(total.sql, /SELECT count\(\*\) AS matches, count\(DISTINCT session_id\) AS sessions\nFROM m2$/);
  assert.deepEqual([rows.title, total.title], ['Matches', 'Total']);
});

test('the table takes one page of matches, then joins their events once', () => {
  const { rows } = matchSql('otel', req([{ tool: 'Edit' }, { tool: 'Bash', link: 'next' }], { limit: 50, offset: 100 }));
  assert.match(rows.sql, /page AS \(\n {2}SELECT m\.session_id, m\.pos1, m\.pos2, s\.root_id, s\.title, coalesce\(s\.agent_name, s\.kind\) AS agent, m\.pos2 - m\.pos1 \+ 1 AS span, o\.ts AS sort_at\n {2}FROM m2 m\n {2}JOIN events o ON o\.session_id = m\.session_id AND o\.pos = m\.pos1\n {2}JOIN otel\.agent_sessions s ON s\.session_id = m\.session_id\n {2}ORDER BY sort_at DESC, m\.session_id, m\.pos1\n {2}LIMIT 50 OFFSET 100\n\)/);
  assert.match(rows.sql, /FROM page p LATERAL VIEW posexplode\(array\(p\.pos1, p\.pos2\)\) t AS j, pos\n\)/);
  assert.match(rows.sql, /left\(c\.target, 200\) AS target\nFROM picked k\nJOIN events c ON c\.session_id = k\.session_id AND c\.pos = k\.pos\nORDER BY k\.sort_at DESC, k\.session_id, k\.pos1, k\.j$/);
  // Each step of the pattern joins the events once to find its event, and the table once more to show them.
  assert.equal(rows.sql.match(/JOIN events /g)!.length, 3);
});

test('any later event is found with a window, one per step, and joined by position', () => {
  const { rows } = matchSql('otel', req([{ tool: 'Grep' }, { tool: 'Read', link: 'later' }, { tool: 'Bash', status: 'ok', link: 'later' }]));
  assert.match(rows.sql, /^WITH base AS \(/);
  assert.match(rows.sql, /min\(if\(b\.kind = 'tool_call' AND b\.what = 'Read', b\.pos, NULL\)\) OVER \(PARTITION BY b\.session_id ORDER BY b\.pos ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING\) AS n2/);
  assert.match(rows.sql, /b\.status = 'ok', b\.pos, NULL\)\) OVER \(.*\) AS n3/);
  assert.match(rows.sql, /SELECT a\.session_id, a\.pos AS pos1, a\.n2 AS nx2\n {2}FROM events a/);
  assert.match(rows.sql, /SELECT m\.session_id, m\.pos1, c\.pos AS pos2, c\.n3 AS nx3\n {2}FROM m1 m\n {2}JOIN events c ON c\.session_id = m\.session_id AND c\.pos = m\.nx2\n\)/);
  assert.match(rows.sql, /JOIN events c ON c\.session_id = m\.session_id AND c\.pos = m\.nx3\n\)/);
});

test('the same target as an earlier step is carried along and compared', () => {
  const { rows } = matchSql('otel', req([{ tool: 'Edit' }, { tool: 'Bash', link: 'next' }, { tool: 'Edit', same: 1, link: 'later' }]));
  assert.match(rows.sql, /SELECT a\.session_id, a\.pos AS pos1, a\.target AS res1\n/);
  assert.match(rows.sql, /SELECT m\.session_id, m\.pos1, m\.res1, c\.pos AS pos2\n/);
  assert.match(rows.sql, /SELECT m\.session_id, m\.pos1, m\.pos2, m\.res1, min\(c\.pos\) AS pos3\n {2}FROM m2 m\n {2}JOIN events c ON c\.session_id = m\.session_id AND c\.pos > m\.pos2\n {2}WHERE c\.kind = 'tool_call' AND c\.what = 'Edit' AND c\.target = m\.res1 AND c\.target <> ''\n {2}GROUP BY m\.session_id, m\.pos1, m\.pos2, m\.res1\n\)/);
  assert.doesNotMatch(rows.sql, / AS n3/, 'a step compared with an earlier one cannot be found by a window');
});

test('a step on an input or a reply reads the text blocks', () => {
  const { rows } = matchSql('otel', req([{ kind: 'reply', has: 'should i' }, { kind: 'user', link: 'next' }, { tool: 'Bash', any: ['rm -rf', 'drop table'], link: 'later' }]));
  // The event names its text block, so one join by key reads it; no block is looked for by its event.
  assert.match(rows.sql, /^WITH base AS \(/);
  assert.doesNotMatch(rows.sql, /texts AS|event_seq/);
  assert.match(rows.sql, /ELSE coalesce\(if\(m\.kind = 'text', m\.text, NULL\), ''\) END AS target/);
  assert.match(rows.sql, /LEFT JOIN otel\.agent_messages m ON m\.session_id = e\.session_id AND m\.msg_seq = e\.msg_seq/);
  assert.match(rows.sql, /a\.kind = 'llm_call' AND instr\(lower\(a\.target\), 'should i'\) > 0/);
  assert.match(rows.sql, /\(instr\(lower\(b\.target\), 'rm -rf'\) > 0 OR instr\(lower\(b\.target\), 'drop table'\) > 0\)/);
});

test('text from the request appears only inside escaped literals', () => {
  const { rows } = matchSql('otel', req([{ tool: "x' OR 1=1 --", has: "a'b\\", any: ["') OR ('1'='1"] }]));
  assert.ok(rows.sql.includes(String.raw`(instr(lower(a.target), '\') or (\'1\'=\'1') > 0)`));
  assert.ok(rows.sql.includes(String.raw`a.what = 'x\' OR 1=1 --'`));
  assert.ok(rows.sql.includes(String.raw`instr(lower(a.target), 'a\'b\\') > 0`));
});

test('the table sorts by where a match starts, by a step, or by its span', () => {
  const two = [{ tool: 'Read' }, { tool: 'Edit', link: 'later' }];
  assert.match(matchSql('otel', req(two, { sort: 'span', dir: 'asc' })).rows.sql, /m\.pos2 - m\.pos1 \+ 1 AS sort_at\n[^)]*ORDER BY sort_at ASC, m\.session_id, m\.pos1\n[\s\S]*ORDER BY k\.sort_at ASC, k\.session_id, k\.pos1, k\.j$/);
  assert.match(matchSql('otel', req(two, { sort: 'step2' })).rows.sql, /o\.ts AS sort_at\n {2}FROM m2 m\n {2}JOIN events o ON o\.session_id = m\.session_id AND o\.pos = m\.pos2\n/);
  assert.match(matchSql('otel', req(two, { sort: 'turn' })).rows.sql, /o\.turn AS sort_at\n {2}FROM m2 m\n {2}JOIN events o ON o\.session_id = m\.session_id AND o\.pos = m\.pos1\n/);
  assert.match(matchSql('otel', req(two, { sort: 'session', dir: 'asc' })).rows.sql, /s\.title AS sort_at\n/);
  assert.match(matchSql('otel', req(two, { sort: 'agent' })).rows.sql, /AS span, coalesce\(s\.agent_name, s\.kind\) AS sort_at\n/);
  assert.throws(() => matchSql('otel', req(two, { sort: 'step3' })), /unknown sort 'step3'/);
  assert.throws(() => matchSql('otel', req(two, { sort: 'c1.ts; DROP' })), /unknown sort/);
  assert.throws(() => matchSql('otel', req(two, { dir: 'up' as 'asc' })), /sort direction must be asc or desc/);
  assert.throws(() => matchSql('otel', req(two, { limit: 0 })), /limit must be an integer from 1 to 1000/);
  assert.throws(() => matchSql('otel', req(two, { offset: -1 })), /offset must be an integer of 0 or more/);
  // A number too large to be exact is refused, not written into the statement.
  assert.throws(() => matchSql('otel', req(two, { offset: 1e21 })), /offset must be an integer of 0 or more/);
  assert.throws(() => matchSql('otel', req(two, { limit: 1.5 })), /limit must be an integer from 1 to 1000/);
  assert.throws(() => matchSql('otel', req(two, { to: '2026-11-16T00:00:00Z' })), /time range is empty/);
});

test('the rows of the table, one per event, become matches with one entry per step', () => {
  const { matches } = matchSql('otel', req([{ tool: 'Read' }, { kind: 'reply', link: 'later' }]));
  const of = (session: string, pos1: number) => ({ session_id: session, pos1, root_id: 'r', title: 'T', agent: 'main', span: 5 });
  const read = { seq: 3, call_seq: 2, ts: '2026-11-17 10:00:03', turn: 1, step: 1, kind: 'tool_call', what: 'Read', status: 'ok', target: 'a.py' };
  const reply = { seq: 9, call_seq: null, ts: '2026-11-17 10:00:09', turn: 1, step: 4, kind: 'llm_call', what: 'Reply', status: '', target: 'Done.' };
  const rows = [{ ...of('s', 4), j: 0, ...read }, { ...of('s', 4), j: 1, ...reply }, { ...of('s', 7), j: 0, ...read, seq: 6 }, { ...of('s', 7), j: 1, ...reply }];
  const found = matches(rows);
  assert.deepEqual(found[0], {
    session_id: 's', root_id: 'r', title: 'T', agent: 'main', span: 5, ts: '2026-11-17 10:00:03', turn: 1,
    steps: [
      { kind: 'call', seq: 3, call: 2, ts: '2026-11-17 10:00:03', turn: 1, step: 1, what: 'Read', status: 'ok', target: 'a.py' },
      { kind: 'reply', seq: 9, call: null, ts: '2026-11-17 10:00:09', turn: 1, step: 4, what: 'Reply', status: '', target: 'Done.' },
    ],
  });
  assert.deepEqual(found.map((m) => m.steps.map((s) => s.seq)), [[3, 9], [6, 9]]);
  assert.deepEqual(matches([]), []);
  // A match with a row missing is an error, not a shorter match.
  assert.throws(() => matches(rows.slice(0, 3)), /the rows of a match are incomplete/);
  assert.throws(() => matches([rows[0]!, rows[3]!]), /the rows of a match are incomplete/);
});

test('a pattern over the sessions of a tree reads those sessions, whatever their time', () => {
  const head = patternCtes('otel', sessionScope(['fx-main-0001', 'agent-a1']), parsePattern([{ kind: 'reply' }, { tool: 'Bash', link: 'later' }]));
  assert.match(head, /^WITH base AS \(/);
  assert.match(head, /\n {4}AND e\.session_id IN \('fx-main-0001', 'agent-a1'\)\n\)/);
  assert.doesNotMatch(head, /e\.ts >=/);
  assert.match(head, /m2 AS \([^)]*\n\)$/);
  assert.throws(() => sessionScope(["a' OR 1=1"]), /bad session id/);
  assert.throws(() => sessionScope([]), /no session to read/);
});

test('a step of a rule can ask for whole words; a request cannot', () => {
  const head = patternCtes('otel', sessionScope(['s']), [{ kind: 'call', tool: 'Bash', re: '(^|[^a-z])rm( |$)' }]);
  assert.ok(head.includes(String.raw`a.what = 'Bash' AND regexp(lower(a.target), '(^|[^a-z])rm( |$)')`));
  assert.throws(() => parsePattern([{ tool: 'Bash', re: 'rm' }]), /step 1: unknown condition 're'/);
});
