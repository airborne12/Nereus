// The agent table pages without a browser: page definitions, what a row opens, and the state in the address.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterParams } from '../src/api/agents.ts';
import { MESSAGES, openTarget, SESSIONS, sessionName, sessionUrl, shownColumns, STEPS } from '../src/lib/agents/pages.ts';
import {
  conditionFrom, conditionLabel, defaultState, filterText, opsOf, parseTableState, queryOf, resolveRange, serializeTableState, sortBy, syncDraft,
} from '../src/lib/agents/table.ts';

test('the pages list their columns in the order of the specification, the time first', () => {
  assert.deepEqual(shownColumns(SESSIONS, null), ['last_event_at', 'title', 'tool_errors', 'first_input', 'last_output', 'turns', 'steps', 'tokens']);
  assert.deepEqual(shownColumns(STEPS, null), ['ts', 'title', 'agent', 'turn', 'step', 'calls', 'status', 'output', 'ctx_tokens', 'duration_us']);
  assert.equal(shownColumns(MESSAGES, null).length, 11);
  for (const def of [SESSIONS, STEPS, MESSAGES]) assert.equal(def.columns[0]!.kind, 'time', def.name);
  // A choice keeps the page's order; a choice of nothing falls back to the default.
  assert.deepEqual(shownColumns(SESSIONS, ['model', 'title']), ['title', 'model']);
  assert.deepEqual(shownColumns(SESSIONS, ['nope']), shownColumns(SESSIONS, null));
});

test('a session without a title is called by its first input, then by its id', () => {
  assert.equal(sessionName({ session_id: 's1', title: 'Fix the clock', first_input: 'x' }), 'Fix the clock');
  assert.equal(sessionName({ session_id: 's1', title: null, first_input: '  Run the tests\nand more' }), 'Run the tests');
  assert.equal(sessionName({ session_id: 's1', title: '', first_input: null }), 's1');
  // A slash command arrives wrapped in tags; the name keeps the words.
  assert.equal(sessionName({ session_id: 's1', title: null, first_input: '<command-message>review</command-message>\n<command-name>/review</command-name>' }), 'review');
});

test('what a row opens', () => {
  assert.deepEqual(openTarget('sessions', { session_id: 'm' }), { root: 'm', sel: null });
  assert.deepEqual(openTarget('steps', { session_id: 'a', root_id: 'm', seq: '4' }), { root: 'm', sel: 's:a:4' });
  const msg = (extra: Record<string, unknown>) => openTarget('messages', { session_id: 'm', root_id: 'm', ...extra });
  assert.deepEqual(msg({ event_kind: 'llm_call', event_seq: '2', step_seq: '2', turn: 1 }), { root: 'm', sel: 's:m:2' });
  assert.deepEqual(msg({ event_kind: 'tool_call', event_seq: '4', step_seq: '2', turn: 1 }), { root: 'm', sel: 's:m:2' });
  assert.deepEqual(msg({ event_kind: 'compaction', event_seq: '12', step_seq: null, turn: 2 }), { root: 'm', sel: 'c:m:12' });
  assert.deepEqual(msg({ event_kind: 'user_input', event_seq: '11', step_seq: null, turn: 2 }), { root: 'm', sel: 't:m:2' });
  assert.deepEqual(msg({ event_kind: null, event_seq: null, step_seq: null, turn: null }), { root: 'm', sel: null });
  assert.equal(sessionUrl('m', 's:a:b:4'), '/agents/sessions/m?sel=s%3Aa%3Ab%3A4');
  assert.equal(sessionUrl('a/b', null), '/agents/sessions/a%2Fb');
});

test('the state of a table page round-trips through the address; defaults are left out', () => {
  assert.equal(serializeTableState(defaultState(SESSIONS), SESSIONS), '');
  const s = {
    range: { from: 1000, to: 5000 }, q: 'fix "public API"',
    conditions: [{ column: 'tool_errors', op: 'ge' as const, value: '1' }, { column: 'title', op: 'contains' as const, value: 'a:b c' }],
    sort: 'tokens', dir: 'asc' as const, columns: ['last_event_at', 'title', 'model'],
  };
  assert.deepEqual(parseTableState(serializeTableState(s, SESSIONS), SESSIONS), s);
  const preset = { ...defaultState(STEPS), range: { preset: '30d' as const } };
  assert.equal(serializeTableState(preset, STEPS), '?t=30d');
  assert.deepEqual(parseTableState('?t=30d', STEPS), preset);
});

test('an address that says something wrong falls back to the default for that part', () => {
  const s = parseTableState('?t=9y&sort=nope&dir=up&f=nope:eq:1&f=turns:like:1&f=bad&f=turns:ge:3&cols=nope,model&from=5&to=2', SESSIONS);
  assert.deepEqual(s, { ...defaultState(SESSIONS), conditions: [{ column: 'turns', op: 'ge', value: '3' }], columns: ['model'] });
});

test('a range ends now unless it is fixed; a request carries the range, the conditions and one page', () => {
  assert.deepEqual(resolveRange({ preset: '24h' }, 100_000_000), { from: 13_600_000, to: 100_000_000 });
  assert.deepEqual(resolveRange({ from: 1, to: 2 }, 99), { from: 1, to: 2 });
  const state = { ...defaultState(STEPS), q: ' read ', conditions: [{ column: 'status', op: 'eq' as const, value: 'failed' }] };
  const q = queryOf(state, Date.UTC(2026, 10, 18), 200);
  assert.deepEqual([q.conditions, q.sort, q.dir, q.limit, q.offset], [['status:eq:failed'], 'ts', 'desc', 100, 200]);
  assert.equal(filterParams(q).toString(),
    'from=2026-11-11T00%3A00%3A00.000Z&to=2026-11-18T00%3A00%3A00.000Z&q=read&f=status%3Aeq%3Afailed&sort=ts&dir=desc');
});

test('conditions: comparisons by kind, a duration typed in seconds, numbers checked', () => {
  assert.deepEqual([opsOf('time'), opsOf('text'), opsOf('enum'), opsOf('duration')], [[], ['contains', 'eq'], ['eq', 'ne'], ['ge', 'le', 'eq']]);
  assert.deepEqual(conditionFrom(STEPS, 'duration_us', 'ge', ' 2.5 '), { column: 'duration_us', op: 'ge', value: '2500000' });
  assert.deepEqual(conditionFrom(STEPS, 'status', 'eq', 'failed'), { column: 'status', op: 'eq', value: 'failed' });
  assert.equal(conditionFrom(STEPS, 'ctx_tokens', 'ge', '12k'), 'Context is compared with a number.');
  assert.equal(conditionFrom(STEPS, 'ctx_tokens', 'ge', '-5'), 'Context is compared with a number.');
  assert.equal(conditionFrom(STEPS, 'status', 'eq', '  '), 'Type a value.');
  assert.equal(conditionFrom(STEPS, 'ts', 'eq', 'x'), 'Choose a column and a comparison.');
  assert.equal(conditionFrom(STEPS, 'status', 'ge', 'x'), 'Choose a column and a comparison.');
});

test('a condition and a filter in the words of the page', () => {
  assert.equal(conditionLabel(STEPS, { column: 'duration_us', op: 'ge', value: '2500000' }), 'Latency ≥ 2.5s');
  assert.equal(conditionLabel(STEPS, { column: 'ctx_tokens', op: 'le', value: '120000' }), 'Context ≤ 120k');
  assert.equal(conditionLabel(STEPS, { column: 'cache_pct', op: 'eq', value: '90' }), 'Cache hit = 90%');
  assert.equal(conditionLabel(MESSAGES, { column: 'msg_role', op: 'ne', value: 'tool' }), 'Role ≠ tool');
  const state = { ...defaultState(MESSAGES), q: 'utc', conditions: [{ column: 'msg_role', op: 'eq' as const, value: 'assistant' }] };
  assert.equal(filterText(MESSAGES, state, String), 'Past 7 days · search "utc" · Role = assistant');
  assert.equal(filterText(MESSAGES, { ...state, q: '', conditions: [], range: { from: 1, to: 2 } }, String), '1 to 2');
});

test('sorting by a column: descending first, the other way on a second click', () => {
  const a = sortBy(defaultState(SESSIONS), 'tokens');
  assert.deepEqual([a.sort, a.dir], ['tokens', 'desc']);
  assert.equal(sortBy(a, 'tokens').dir, 'asc');
  assert.equal(sortBy(sortBy(a, 'tokens'), 'tokens').dir, 'desc');
  assert.equal(sortBy(defaultState(SESSIONS), 'last_event_at').dir, 'asc');
});

test('a range outside what a date can hold falls back to the default, so no request is built from it', () => {
  assert.deepEqual(parseTableState('?from=0&to=9000000000000000', SESSIONS).range, { preset: '7d' });
  assert.deepEqual(parseTableState('?from=-9000000000000000&to=5', SESSIONS).range, { preset: '7d' });
  assert.deepEqual(parseTableState('?from=1&to=8640000000000000', SESSIONS).range, { from: 1, to: 8_640_000_000_000_000 });
});

test('the search box keeps what is being typed when the address catches up with it', () => {
  // The address stores the search trimmed; a space typed at the end must survive the search running.
  assert.equal(syncDraft('public ', 'public'), 'public ');
  assert.equal(syncDraft('public', 'public'), 'public');
  // A search set from elsewhere (the address, another page) replaces the box.
  assert.equal(syncDraft('public', 'other'), 'other');
  assert.equal(syncDraft('typed', ''), '');
});
