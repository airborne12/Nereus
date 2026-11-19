// The two read-only trajectory tools with a stub in place of Doris: a search runs the statement of
// the table page it names, a read answers a session's turns, one turn or one step, and a wrong
// argument is a tool error the model can read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEARCH_LIMIT, TOOLS, trajectoryTools } from '../src/api/mcp/tools.ts';
import type { Doris } from '../src/db/doris.ts';

const NOW = Date.parse('2026-11-19T12:00:00Z');

/** A Doris that answers each statement with `rows` when it gives any, else with a small stand-in. */
function stub(rows: (sql: string) => Record<string, unknown>[] | undefined = () => undefined) {
  const seen: string[] = [];
  const doris = {
    query: async (sql: string) => {
      seen.push(sql);
      const given = rows(sql);
      if (given) return given;
      if (sql.startsWith('SELECT count(*)')) return [{ total: 12, bytes: 0 }];
      if (sql.includes('WITH RECURSIVE') || sql.includes("WHERE root_id = (SELECT root_id")) return [{ session_id: 's-1', kind: 'main', title: 'Fix the clock' }];
      if (sql.startsWith('SELECT t.session_id, t.turn')) return Array.from({ length: 3 }, (_, i) => ({ session_id: 's-1', turn: i + 1, user_input: `ask ${i + 1}` }));
      return [{ session_id: 's-1', seq: 4, text: 'x' }];
    },
  } as unknown as Doris;
  return { doris, seen };
}

const call = async (name: string, args: Record<string, unknown>, doris = stub()) => {
  const r = (await trajectoryTools(doris.doris, 'otel', () => NOW).call(name, args))!;
  return { r, json: r.isError ? null : JSON.parse(r.content[0]!.text), seen: doris.seen };
};

test('two tools, both read-only, with an input schema each', () => {
  assert.deepEqual(TOOLS.map((t) => [t.name, t.annotations.readOnlyHint]), [['trajectory_search', true], ['trajectory_read', true]]);
  assert.deepEqual((TOOLS[0]!.inputSchema.properties as Record<string, { enum?: string[] }>).table!.enum, ['sessions', 'steps', 'messages']);
  assert.deepEqual(TOOLS[1]!.inputSchema.required, ['session_id']);
});

test('a search runs the statement of the table page it names, over the past 7 days unless told, a page of rows at most', async () => {
  const { json, seen } = await call('trajectory_search', { table: 'steps', q: 'timeout', conditions: ['status:eq:failed'], limit: 500 });
  assert.deepEqual([json.table, json.total, json.from, json.to, json.rows.length], ['steps', 12, '2026-11-12T12:00:00.000Z', '2026-11-19T12:00:00.000Z', 1]);
  assert.match(seen[0]!, new RegExp(`LIMIT ${SEARCH_LIMIT} OFFSET 0$`), 'a limit over the most is cut to it');
  assert.match(seen[0]!, /timeout/);
  const sessions = await call('trajectory_search', { table: 'sessions', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' });
  assert.match(sessions.seen[0]!, /2026-11-01 00:00:00/);
});

test('a search with a table, a condition or a time it cannot read is a tool error that says why', async () => {
  for (const [args, said] of [
    [{ table: 'secrets' }, /table must be sessions, steps or messages/],
    [{ table: 'steps', conditions: ['nonsense'] }, /condition/],
    [{ table: 'steps', from: 'yesterday' }, /from must be a time/],
  ] as const) {
    const { r } = await call('trajectory_search', args);
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, said);
  }
});

test("a read answers a session's turns, one turn with its steps, or one step's output", async () => {
  const whole = await call('trajectory_read', { session_id: 's-1' });
  assert.deepEqual([whole.json.sessions.length, whole.json.turns.map((t: { turn: number }) => t.turn), whole.json.cut], [1, [1, 2, 3], undefined]);
  assert.match(whole.seen[1]!, /^SELECT t\.session_id, t\.turn/);
  const turn = await call('trajectory_read', { session_id: 's-1', turn: 2 });
  assert.deepEqual([turn.json.turn, turn.json.blocks, turn.json.steps], [2, [{ session_id: 's-1', seq: 4, text: 'x' }], [{ nth: null, events: [{ session_id: 's-1', seq: 4, text: 'x' }] }]]);
  assert.match(turn.seen[0]!, /^SELECT m\.msg_seq/);
  assert.match(turn.seen[1]!, /e\.turn = 2 AND /);
  const step = await call('trajectory_read', { session_id: 's-1', seq: 4 });
  assert.deepEqual([step.json.seq, step.json.step, step.json.output], [4, { session_id: 's-1', seq: 4, text: 'x' }, [{ session_id: 's-1', seq: 4, text: 'x' }]]);
  const bad = await call('trajectory_read', { session_id: "x' OR 1=1" });
  assert.deepEqual([bad.r.isError, bad.r.content[0]!.text], [true, 'bad session id']);
  const first = await call('trajectory_read', { session_id: 's-1', turn: 0 });
  assert.equal(first.r.isError, undefined, 'turn 0, the events before the first request, is listed and can be read');
  assert.match(first.seen[1]!, /e\.turn = 0 AND /);
  const empty = await call('trajectory_read', { session_id: 's-1', turn: 9 }, stub((sql) => (sql.startsWith('SELECT m.msg_seq') || sql.startsWith('SELECT * FROM') ? [] : undefined)));
  assert.deepEqual([empty.r.isError, empty.r.content[0]!.text], [true, 'no such turn in this session']);
});

test('a time without a zone is UTC, as the rows give it; text that is not a time is refused', async () => {
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const { seen } = await call('trajectory_search', { table: 'sessions', from: '2026-11-17 10:12:13.123456', to: '2026-11-18 00:00:00' });
    assert.match(seen[0]!, /'2026-11-17 10:12:13\.123'/);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  for (const bad of ['Nov 17 2026', '1']) {
    const { r } = await call('trajectory_search', { table: 'steps', from: bad });
    assert.match(r.content[0]!.text, /from must be a time in ISO 8601/, bad);
  }
});

test('an argument the tool does not take, or of the wrong kind, is a tool error that says why', async () => {
  for (const [name, args, said] of [
    ['trajectory_search', { table: 'steps', sort: 'ts' }, /unknown argument sort; trajectory_search takes table, q, conditions, from, to, limit, offset/],
    ['trajectory_search', { table: 'steps', q: ['a', 'b'] }, /q must be a string of words/],
    ['trajectory_search', { table: 'steps', q: 5 }, /q must be a string of words/],
    ['trajectory_search', { table: 'constructor' }, /table must be sessions, steps or messages/],
    ['trajectory_read', { session_id: 's-1', turn: 1, seq: 4 }, /give turn or seq, not both/],
    ['trajectory_read', { session_id: 7 }, /session_id must be a string/],
  ] as const) {
    const { r } = await call(name, args);
    assert.deepEqual([r.isError, said.test(r.content[0]!.text)], [true, true], r.content[0]!.text);
  }
});

const long = (n: number) => 'z'.repeat(n);

test('a search too long for one answer comes back as whole rows, with the offset of the rest', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ session_id: `s-${i}`, first_input: long(3000) }));
  const { json } = await call('trajectory_search', { table: 'sessions', limit: 50, offset: 10 }, stub((sql) => (sql.startsWith('SELECT count(*)') ? [{ total: 200 }] : sql.includes('LIMIT') ? rows : undefined)));
  assert.ok(json.rows.length > 1 && json.rows.length < 50, String(json.rows.length));
  assert.deepEqual(json.cut, { returned: json.rows.length, next_offset: 10 + json.rows.length, note: 'Call again with offset set to next_offset for the rest.' });
  assert.equal(json.rows.at(-1).session_id, `s-${json.rows.length - 1}`, 'whole rows, in order');
});

test("a session's turns: the main session's first, 200 at a time, long text shortened with what was left out", async () => {
  const tree = [{ session_id: 's-1', kind: 'main' }, { session_id: 'agent-a', kind: 'subagent' }];
  const turns = [...Array.from({ length: 30 }, (_, i) => ({ session_id: 'agent-a', turn: i + 1, user_input: 'sub' })), ...Array.from({ length: 200 }, (_, i) => ({ session_id: 's-1', turn: i + 1, user_input: i === 0 ? long(8000) : 'ask' }))];
  const answer = (sql: string) => (sql.includes("WHERE root_id = (SELECT root_id") ? tree : sql.startsWith('SELECT t.session_id, t.turn') ? turns : undefined);
  const first = (await call('trajectory_read', { session_id: 's-1' }, stub(answer))).json;
  assert.deepEqual([first.turns[0].session_id, first.turns[0].turn, first.turns.at(-1).session_id], ['s-1', 1, 's-1']);
  assert.match(first.turns[0].user_input, /^z{4000}… \(4000 more characters\)$/);
  assert.equal(first.cut.next_offset, first.turns.length);
  const rest = (await call('trajectory_read', { session_id: 's-1', offset: 200 }, stub(answer))).json;
  assert.deepEqual([rest.turns.length, rest.turns[0].session_id, rest.cut], [30, 'agent-a', undefined]);
});

test("a turn's steps come by whole model calls, from an offset; a step's long output is shortened", async () => {
  const steps = Array.from({ length: 100 }, (_, i) => [
    { seq: 2 * i, kind: 'llm_call', nth: 51 + i }, { seq: 2 * i + 1, kind: 'tool_call', nth: 51 + i, resource: long(900) },
  ]).flat();
  const turn = await call('trajectory_read', { session_id: 's-1', turn: 3, offset: 50 }, stub((sql) => (sql.startsWith('SELECT * FROM') ? steps : undefined)));
  assert.match(turn.seen[1]!, /WHERE nth > 50 AND nth <= 150/);
  assert.ok(turn.json.steps.length < 100 && turn.json.steps.every((g: { events: unknown[] }) => g.events.length === 2), 'whole model calls with their tool calls');
  assert.deepEqual([turn.json.steps[0].nth, turn.json.cut.next_offset], [51, 50 + turn.json.steps.length]);
  const step = await call('trajectory_read', { session_id: 's-1', seq: 4 }, stub((sql) => (sql.includes('m.payload') ? [{ msg_seq: 1, text: long(100_000), chars: 100_000 }] : undefined)));
  assert.match(step.json.output[0].text, /^z{4000}… \(96000 more characters\)$/);
});

test('a failure of Doris is a tool error with its message', async () => {
  const down = { query: async () => { throw new Error('Doris is down'); } } as unknown as Doris;
  const r = (await trajectoryTools(down, 'otel', () => NOW).call('trajectory_search', { table: 'steps' }))!;
  assert.deepEqual([r.isError, r.content[0]!.text], [true, 'Doris is down']);
});

test('an unknown tool is not one of these', async () => {
  assert.equal(await trajectoryTools(stub().doris, 'otel').call('nope', {}), null);
});
