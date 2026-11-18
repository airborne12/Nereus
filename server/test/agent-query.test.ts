// The table request of the agent pages and the SQL built from it (no database).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messagesPage, sessionsPage, stepsPage } from '../src/semantics/trajectory/pages.ts';
import { parseCondition, parseTerms, tableSql, type TableRequest } from '../src/semantics/trajectory/query.ts';

const req = (extra: Partial<TableRequest> = {}): TableRequest =>
  ({ from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z', q: '', conditions: [], limit: 100, offset: 0, ...extra });

test('parseTerms: words, quoted phrases, an unclosed quote, at most 8 terms', () => {
  assert.deepEqual(parseTerms('  fix  "public API"  test '), ['fix', 'public API', 'test']);
  assert.deepEqual(parseTerms('"unclosed phrase'), ['unclosed phrase']);
  assert.deepEqual(parseTerms(''), []);
  assert.throws(() => parseTerms('a b c d e f g h i'), /at most 8/);
});

test('parseCondition: column:op:value, the value may hold colons', () => {
  assert.deepEqual(parseCondition('steps:ge:7'), { column: 'steps', op: 'ge', value: '7' });
  assert.deepEqual(parseCondition('started_at:lt:2026-11-17 10:00:00'), { column: 'started_at', op: 'lt', value: '2026-11-17 10:00:00' });
  assert.throws(() => parseCondition('steps:like:7'), /unknown comparison/);
  assert.throws(() => parseCondition('steps'), /column:op:value/);
});

test('Sessions: fixed condition, range, search on three columns, conditions, sort and paging', () => {
  const { rows, total } = tableSql(sessionsPage('otel'), req({
    q: "clock it's", conditions: [parseCondition('steps:ge:7'), parseCondition('model:contains:OPUS'), parseCondition('first_input:contains:fail')],
    sort: 'steps', dir: 'asc', offset: 200,
  }), 'list');
  assert.match(rows.sql, /FROM otel\.agent_sessions s\nWHERE s\.kind = 'main'/);
  assert.match(rows.sql, /s\.last_event_at >= '2026-11-17 00:00:00\.000' AND s\.last_event_at < '2026-11-18 00:00:00\.000'/);
  assert.match(rows.sql, /\(s\.title MATCH_PHRASE 'clock' OR s\.first_input MATCH_PHRASE 'clock' OR s\.last_output MATCH_PHRASE 'clock'\)/);
  assert.match(rows.sql, /s\.title MATCH_PHRASE 'it\\'s'/);
  assert.match(rows.sql, /s\.steps >= 7/);
  assert.match(rows.sql, /instr\(lower\(s\.model\), 'opus'\) > 0/);
  assert.match(rows.sql, /s\.first_input MATCH_PHRASE 'fail'/);
  assert.match(rows.sql, /left\(s\.first_input, 1000\) AS `first_input`/);
  assert.match(rows.sql, /ORDER BY s\.steps ASC, s\.session_id\nLIMIT 100 OFFSET 200$/);
  assert.match(total.sql, /^SELECT count\(\*\) AS total\nFROM otel\.agent_sessions s\nWHERE /);
  assert.doesNotMatch(total.sql, /ORDER BY|LIMIT/);
});

test('an export carries whole text and every row up to the cap plus one', () => {
  const { rows } = tableSql(sessionsPage('otel'), req(), 'export', 500);
  assert.match(rows.sql, /s\.first_input AS `first_input`/);
  assert.doesNotMatch(rows.sql, /left\(/);
  assert.match(rows.sql, /ORDER BY s\.last_event_at DESC, s\.session_id\nLIMIT 501$/);
});

test('Steps join one table per search term; Messages search the block text', () => {
  const steps = tableSql(stepsPage('otel'), req({ q: 'read "the test"' }), 'list').rows.sql;
  assert.match(steps, /text MATCH_PHRASE 'read'\n\) w0 ON w0\.session_id = m\.session_id AND w0\.api_msg = m\.api_msg/);
  assert.match(steps, /text MATCH_PHRASE 'the test'\n\) w1 ON/);
  assert.match(steps, /WHERE e\.kind = 'llm_call'/);
  // Joined tables get one more day, so a step at the end of the range keeps its tool calls.
  assert.match(steps, /WHERE kind = 'tool_call' AND ts >= '2026-11-17 00:00:00\.000' AND ts < '2026-11-19 00:00:00\.000'/);
  const msgs = tableSql(messagesPage('otel'), req({ q: 'utc' }), 'list').rows.sql;
  assert.match(msgs, /AND m\.text MATCH_PHRASE 'utc'/);
});

test('search text and condition values are literals: quotes, backslashes and percent signs', () => {
  const sql = tableSql(messagesPage('otel'), req({ q: '100% \\x', conditions: [parseCondition("tool_name:eq:a'b")] }), 'list').rows.sql;
  assert.match(sql, /m\.text MATCH_PHRASE '100%'/);
  assert.match(sql, /m\.text MATCH_PHRASE '\\\\x'/);
  assert.match(sql, /m\.tool_name = 'a\\'b'/);
});

test('refused: unknown columns, wrong kinds, non-numbers, an empty range', () => {
  const page = sessionsPage('otel');
  assert.throws(() => tableSql(page, req({ conditions: [parseCondition('nope:eq:1')] }), 'list'), /unknown column 'nope'/);
  assert.throws(() => tableSql(page, req({ conditions: [parseCondition('steps:contains:1')] }), 'list'), /needs a text column/);
  assert.throws(() => tableSql(page, req({ conditions: [parseCondition('steps:gt:1; DROP')] }), 'list'), /not a number/);
  assert.throws(() => tableSql(page, req({ sort: 'steps;' }), 'list'), /unknown column/);
  assert.throws(() => tableSql(page, req({ to: '2026-11-17T00:00:00Z' }), 'list'), /time range is empty/);
});

test('refused: a sort direction other than asc or desc', () => {
  assert.throws(() => tableSql(sessionsPage('otel'), req({ dir: 'up' as TableRequest['dir'] }), 'list'), /sort direction/);
});

test('refused: a limit outside 1 to 1000 and an offset that is negative or fractional', () => {
  const page = sessionsPage('otel');
  assert.throws(() => tableSql(page, req({ limit: 0 }), 'list'), /limit/);
  assert.throws(() => tableSql(page, req({ limit: 1001 }), 'list'), /limit/);
  assert.throws(() => tableSql(page, req({ offset: -1 }), 'list'), /offset/);
  assert.throws(() => tableSql(page, req({ offset: 1.5 }), 'list'), /offset/);
});

test('refused: a comparison name that is only an object property', () => {
  assert.throws(() => parseCondition('x:constructor:1'), /unknown comparison/);
});

test('comparisons ne, lt and le and a time-kind condition', () => {
  const page = sessionsPage('otel');
  const sql = tableSql(page, req({
    conditions: [parseCondition('steps:ne:7'), parseCondition('steps:lt:3'), parseCondition('steps:le:5'),
      parseCondition('started_at:ge:2026-11-17 10:00:00')],
  }), 'list').rows.sql;
  assert.match(sql, /s\.steps <> 7/);
  assert.match(sql, /s\.steps < 3/);
  assert.match(sql, /s\.steps <= 5/);
  assert.match(sql, /s\.started_at >= '2026-11-17 10:00:00\.000'/);
});
