// Statements of the session page (no database).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionSql, marksSql, sessionId, stepSql, treeSql, turnStepsSql, turnSql, turnsSql } from '../src/semantics/trajectory/session.ts';

test('session ids: refused before they reach SQL', () => {
  assert.equal(sessionId('agent-a1b2c3'), 'agent-a1b2c3');
  assert.equal(sessionId('0f0e0d0c-0b0a-4908-8706-050403020100'), '0f0e0d0c-0b0a-4908-8706-050403020100');
  for (const bad of ["x'", 'a b', '', 'x'.repeat(129)]) assert.throws(() => sessionId(bad), /bad session id/);
});

test('the tree carries what a session is called by and what it ended with', () => {
  assert.match(treeSql('otel', 'm').sql, /'?safety_risks, first_input, last_output\nFROM otel\.agent_sessions/);
});

test('the tree of any branch is the tree of its root', () => {
  assert.match(treeSql('otel', 'agent-1').sql, /WHERE root_id = \(SELECT root_id FROM otel\.agent_sessions WHERE session_id = 'agent-1'\)/);
});

test('turns: one row per branch and turn; a closed turn shows its tool chain', () => {
  const sql = turnsSql('otel', ['m', 'a']).sql;
  assert.match(sql, /WHERE e\.session_id IN \('m', 'a'\)\n  GROUP BY e\.session_id, e\.turn/);
  assert.match(sql, /group_concat\(if\(e\.kind = 'tool_call', concat\(e\.name, if\(e\.status = 'error', ' failed', ''\)\), NULL\), ',' ORDER BY e\.seq\) AS tools/);
});

test('a page of a turn counts model calls; a compaction before the first call is on page one', () => {
  const sql = turnStepsSql('otel', 'm', 3, 100).sql;
  assert.match(sql, /greatest\(sum\(if\(e\.kind = 'llm_call', 1, 0\)\) OVER \(ORDER BY e\.seq\), 1\) AS nth/);
  assert.match(sql, /e\.session_id = 'm' AND e\.turn = 3/);
  assert.match(sql, /WHERE nth > 100 AND nth <= 200/);
});

test('a turn reads the input and the text of its last model call', () => {
  assert.match(turnSql('otel', 'm', 2).sql, /m\.msg_seq = t\.asked OR \(m\.event_seq = t\.last_call AND m\.kind = 'text'\)/);
});

test('a step: only a model call; input latest first, one page at a time; the prompt by hash', () => {
  const s = stepSql('otel', 'm', 5, 200);
  assert.match(s.event.sql, /seq = 5 AND kind = 'llm_call'/);
  assert.match(s.input.sql, /c\.seq = 5 AND c\.rel = 'in'\nORDER BY c\.pos DESC, m\.msg_seq DESC\nLIMIT 100 OFFSET 200$/);
  assert.match(s.input.sql, /left\(m\.text, 100000\) AS text, char_length\(m\.text\) AS chars/);
  assert.match(s.output.sql, /e\.seq = 5 OR e\.parent_seq = 5/);
  assert.match(s.prompt.sql, /p\.prompt_hash = \(SELECT prompt_hash FROM otel\.agent_events WHERE session_id = 'm' AND seq = 5\)/);
});

test('a compaction reads the context change of the next model call', () => {
  const c = compactionSql('otel', 'm', 12);
  assert.match(c.event.sql, /seq = 12 AND kind = 'compaction'/);
  assert.match(c.blocks.sql, /c\.seq = \(SELECT min\(seq\) FROM otel\.agent_events WHERE session_id = 'm' AND kind = 'llm_call' AND seq > 12\)/);
  assert.match(c.blocks.sql, /c\.rel = 'out' OR m\.kind = 'summary'/);
});

test('numeric arguments: whole numbers from 0 only, refused before they reach SQL', () => {
  assert.throws(() => turnStepsSql('otel', 'm', 1, -1), /must be a whole number from 0/);
  assert.throws(() => turnStepsSql('otel', 'm', Number.NaN, 0), /must be a whole number from 0/);
  assert.throws(() => turnSql('otel', 'm', 1e21), /must be a whole number from 0/);
  assert.throws(() => stepSql('otel', 'm', Number.NaN, 0), /must be a whole number from 0/);
  assert.throws(() => stepSql('otel', 'm', 5, 1.5), /must be a whole number from 0/);
  assert.throws(() => compactionSql('otel', 'm', Number.POSITIVE_INFINITY), /must be a whole number from 0/);
  assert.equal(turnSql('otel', 'm', 0).title, 'Turn 0');
});

test('a bad session id is refused on the turns path too', () => {
  assert.throws(() => turnsSql('otel', ["x'"]), /bad session id/);
});

test('turns also say where their steps start and end and whether every context is exact', () => {
  const sql = turnsSql('otel', ['m']).sql;
  assert.match(sql, /min\(if\(e\.kind = 'llm_call', e\.step, NULL\)\) AS first_step/);
  assert.match(sql, /max\(if\(e\.kind = 'llm_call', e\.seq, NULL\)\) AS last_call/);
  assert.match(sql, /min\(if\(e\.kind = 'llm_call', if\(e\.ctx_exact, 1, 0\), NULL\)\) AS ctx_exact/);
  assert.match(sql, /t\.tools, t\.first_step, t\.last_call, t\.ctx_exact\nFROM/);
});

test('marks: failed and repeated calls, calls that started a sub-agent, and compactions, at most 2000', () => {
  const sql = marksSql('otel', ['m', 'a']).sql;
  assert.match(sql, /LEFT JOIN otel\.agent_sessions c ON c\.parent_id = e\.session_id AND c\.parent_seq = e\.seq/);
  assert.match(sql, /WHERE e\.session_id IN \('m', 'a'\)/);
  assert.match(sql, /e\.kind = 'compaction' OR \(e\.kind = 'tool_call' AND \(e\.status = 'error' OR e\.repeat_of IS NOT NULL OR c\.session_id IS NOT NULL\)\)/);
  // The calls that started a sub-agent and the compactions hold the structure of the page: they come first.
  // One row more than the limit is read, so a cut shows.
  assert.match(sql, /ORDER BY if\(e\.kind = 'compaction' OR c\.session_id IS NOT NULL, 0, 1\), e\.session_id, e\.seq\nLIMIT 2001$/);
  assert.throws(() => marksSql('otel', ["m'"]), /bad session id/);
});
