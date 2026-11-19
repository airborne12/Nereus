// The sequence routes with a stub in place of Doris: what each answers, and what is refused.

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { agentRoutes } from '../src/api/agents/routes.ts';
import type { Doris } from '../src/db/doris.ts';

function stub(answer: (sql: string) => Record<string, unknown>[]) {
  const seen: string[] = [];
  const doris = { query: async (sql: string) => { seen.push(sql); return answer(sql); } } as unknown as Doris;
  return { doris, seen };
}

function call(doris: Doris, path: string, body?: unknown) {
  const answers: { status: number; body: any }[] = [];
  const routes = agentRoutes({ doris, db: 'otel', send: (_res, status, b) => answers.push({ status, body: b }) });
  const res = { writeHead: () => res, end: () => undefined } as unknown as ServerResponse;
  const req = (body === undefined
    ? { method: 'GET', headers: {} }
    : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: { 'content-type': 'application/json' } })) as unknown as IncomingMessage;
  return { done: routes.handle(req, res, new URL(`http://x${path}`)), answers };
}

const RANGE = 'from=2026-11-17T00:00:00Z&to=2026-11-18T00:00:00Z';
const BODY = { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' };

test('what happens next answers the tree, the statement and the time', async () => {
  const { doris, seen } = stub(() => [
    { level: 2, k2: 'c:Read', k3: '', k4: '', times: 3, rk: 1, siblings: 2, parent_times: 4, total: 4 },
    { level: 2, k2: '', k3: '', k4: '', times: 1, rk: 2, siblings: 2, parent_times: 4, total: 4 },
  ]);
  const c = call(doris, `/api/agents/sequences/next?${RANGE}`);
  assert.equal(await c.done, true);
  const a = c.answers[0]!;
  assert.equal(a.status, 200);
  assert.deepEqual([a.body.start, a.body.depth, a.body.total, a.body.other], ['failed', 4, 4, null]);
  assert.deepEqual(a.body.kids, [{ key: 'c:Read', times: 3, kids: [], other: null }, { key: '', times: 1, kids: [], other: null }]);
  assert.deepEqual(a.body.sql.map((s: any) => s.title), ['Paths']);
  assert.equal(typeof a.body.elapsedMs, 'number');
  assert.match(seen[0]!, /WHERE kind = 'tool_call' AND status = 'error'/);
});

test('what happens next takes its start and depth from the address', async () => {
  const { doris, seen } = stub(() => []);
  const c = call(doris, `/api/agents/sequences/next?${RANGE}&start=tool:Bash&depth=3`);
  await c.done;
  assert.deepEqual([c.answers[0]!.body.start, c.answers[0]!.body.depth, c.answers[0]!.body.total], ['tool:Bash', 3, 0]);
  assert.match(seen[0]!, /what = 'Bash'/);
  await assert.rejects(call(doris, '/api/agents/sequences/next').done, /'from' and 'to' are required/);
  await assert.rejects(call(doris, `/api/agents/sequences/next?${RANGE}&depth=9`).done, /'depth' must be an integer from 2 to 4/);
  await assert.rejects(call(doris, `/api/agents/sequences/next?${RANGE}&depth=abc`).done, /'depth' must be an integer from 2 to 4/);
  await assert.rejects(call(doris, `/api/agents/sequences/next?${RANGE}&start=Bash`).done, /'start' must be/);
});

test('the tools of a range', async () => {
  const { doris } = stub(() => [{ name: 'Bash', calls: 7 }, { name: 'Read', calls: 2 }]);
  const c = call(doris, `/api/agents/sequences/tools?${RANGE}`);
  await c.done;
  assert.deepEqual(c.answers[0]!.body.tools, [{ name: 'Bash', calls: 7 }, { name: 'Read', calls: 2 }]);
  assert.deepEqual(c.answers[0]!.body.sql.map((s: any) => s.title), ['Tools']);
});

test('a pattern is posted and answers its matches and totals', async () => {
  const match = { session_id: 's', pos1: 5, root_id: 's', title: 'T', agent: 'main', span: 2, call_seq: 2, turn: 1, step: 1, kind: 'tool_call' };
  const { doris, seen } = stub((sql) => (sql.includes('count(*) AS matches') ? [{ matches: 12, sessions: 3 }] : [
    { ...match, j: 0, seq: 3, ts: '2026-11-17 10:00:03', what: 'Edit', status: 'ok', target: 'a.py' },
    { ...match, j: 1, seq: 4, ts: '2026-11-17 10:00:04', what: 'Bash', status: 'error', target: 'pytest' },
  ]));
  const c = call(doris, '/api/agents/sequences/match', { ...BODY, pattern: [{ tool: 'Edit' }, { tool: 'Bash', status: 'failed', link: 'next' }], sort: 'span', dir: 'asc', limit: 50, offset: 100 });
  assert.equal(await c.done, true);
  const a = c.answers[0]!;
  assert.equal(a.status, 200);
  assert.deepEqual([a.body.matches, a.body.sessions, a.body.rows.length], [12, 3, 1]);
  assert.deepEqual(a.body.rows[0].steps.map((s: any) => [s.kind, s.what, s.status, s.seq, s.call]), [['call', 'Edit', 'ok', 3, 2], ['call', 'Bash', 'error', 4, 2]]);
  assert.deepEqual(a.body.pattern, [{ kind: 'call', tool: 'Edit' }, { kind: 'call', tool: 'Bash', status: 'failed', link: 'next' }]);
  assert.deepEqual(a.body.sql.map((s: any) => s.title), ['Matches', 'Total']);
  assert.equal(seen.length, 2);
  assert.match(seen.find((s) => s.includes('LIMIT'))!, /ORDER BY sort_at ASC, m\.session_id, m\.pos1\n {2}LIMIT 50 OFFSET 100\n/);
});

test('a pattern request is checked before any statement runs', async () => {
  const { doris, seen } = stub(() => []);
  const post = (body: unknown) => call(doris, '/api/agents/sequences/match', body).done;
  await assert.rejects(post({ ...BODY }), /a pattern has 1 to 6 steps/);
  await assert.rejects(post({ ...BODY, pattern: [{ tool: 'Edit' }, { tool: 'Bash' }] }), /step 2: 'link' must be next or later/);
  await assert.rejects(post({ pattern: [{ tool: 'Edit' }] }), /'from' and 'to' are required/);
  await assert.rejects(post({ ...BODY, pattern: [{ tool: 'Edit' }], limit: '5' }), /limit must be an integer from 1 to 1000/);
  await assert.rejects(post({ ...BODY, pattern: [{ tool: 'Edit' }], dir: 'up' }), /sort direction must be asc or desc/);
  assert.equal(seen.length, 0);
  // Without a limit a request gets the page size of the tables.
  await post({ ...BODY, pattern: [{ tool: 'Edit' }] });
  assert.match(seen.find((s) => s.includes('LIMIT'))!, /LIMIT 100 OFFSET 0\n/);
});

test('only the pattern route takes a post, and it takes nothing else', async () => {
  const { doris } = stub(() => []);
  assert.equal(await call(doris, '/api/agents/sessions', {}).done, false, 'a post to a read route is not handled here');
  const get = call(doris, '/api/agents/sequences/match');
  await get.done;
  assert.equal(get.answers[0]!.status, 404);
  const other = call(doris, '/api/agents/sequences/else');
  await other.done;
  assert.equal(other.answers[0]!.status, 404);
});
