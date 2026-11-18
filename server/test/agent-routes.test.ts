// The agent routes with a stub in place of Doris: answer shapes, the export cap, unknown paths.

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { agentRoutes } from '../src/api/agents/routes.ts';
import type { Doris } from '../src/db/doris.ts';
import { MAX_EXPORT_ROWS } from '../src/semantics/trajectory/export.ts';

/** A Doris that answers counts with `total` and everything else with `rows`, recording the SQL. */
function stub(total: number, rows: Record<string, unknown>[] = []) {
  const seen: string[] = [];
  const doris = { query: async (sql: string) => { seen.push(sql); return sql.startsWith('SELECT count(*)') ? [{ total }] : rows; } } as unknown as Doris;
  return { doris, seen };
}

function call(doris: Doris, path: string) {
  const answers: { status: number; body: any }[] = [];
  const routes = agentRoutes({ doris, db: 'otel', send: (_res, status, body) => answers.push({ status, body }) });
  const res = { writeHead: () => res, end: () => undefined } as unknown as ServerResponse;
  const req = { method: 'GET' } as IncomingMessage;
  return { done: routes.handle(req, res, new URL(`http://x${path}`)), answers };
}

const RANGE = 'from=2026-11-17T00:00:00Z&to=2026-11-18T00:00:00Z';

test('a list answers rows, total, columns, the statements and the time', async () => {
  const { doris, seen } = stub(42, [{ session_id: 's' }]);
  const c = call(doris, `/api/agents/sessions?${RANGE}`);
  assert.equal(await c.done, true);
  const a = c.answers[0]!;
  assert.equal(a.status, 200);
  assert.deepEqual([a.body.rows, a.body.total, a.body.sql.map((s: any) => s.title)], [[{ session_id: 's' }], 42, ['Rows', 'Total']]);
  assert.ok(a.body.columns.some((x: any) => x.name === 'first_input' && x.kind === 'text'));
  assert.equal(seen.length, 2);
});

test('an export larger than the cap is refused before its rows are read', async () => {
  const { doris, seen } = stub(MAX_EXPORT_ROWS + 1);
  await assert.rejects(call(doris, `/api/agents/messages?${RANGE}&format=csv`).done, /at most 200000/);
  assert.equal(seen.length, 1, 'only the count ran');
});

test('paths outside the agent API are left to other routes; unknown agent paths answer 404', async () => {
  const { doris } = stub(0);
  assert.equal(await call(doris, '/api/search').done, false);
  const c = call(doris, '/api/agents/nothing');
  assert.equal(await c.done, true);
  assert.equal(c.answers[0]!.status, 404);
});
