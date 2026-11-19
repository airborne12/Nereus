// The two read-only trajectory tools with a stub in place of Doris: a search runs the statement of
// the table page it names, a read answers a session's turns, one turn or one step, and a wrong
// argument is a tool error the model can read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEARCH_LIMIT, TOOLS, trajectoryTools } from '../src/api/mcp/tools.ts';
import type { Doris } from '../src/db/doris.ts';

const NOW = Date.parse('2026-11-19T12:00:00Z');

function stub() {
  const seen: string[] = [];
  const doris = {
    query: async (sql: string) => {
      seen.push(sql);
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
  assert.deepEqual([whole.json.sessions.length, whole.json.turns.map((t: { turn: number }) => t.turn), whole.json.cut], [1, [1, 2, 3], false]);
  const turn = await call('trajectory_read', { session_id: 's-1', turn: 2 });
  assert.deepEqual([turn.json.turn, turn.seen.length], [2, 2]);
  const step = await call('trajectory_read', { session_id: 's-1', seq: 4 });
  assert.deepEqual([step.json.seq, step.seen.length], [4, 2]);
  const bad = await call('trajectory_read', { session_id: "x' OR 1=1" });
  assert.deepEqual([bad.r.isError, bad.r.content[0]!.text], [true, 'bad session id']);
  const none = await call('trajectory_read', { session_id: 's-1', turn: 0 });
  assert.match(none.r.content[0]!.text, /turn must be a whole number from 1/);
});

test('an unknown tool is not one of these', async () => {
  assert.equal(await trajectoryTools(stub().doris, 'otel').call('nope', {}), null);
});
