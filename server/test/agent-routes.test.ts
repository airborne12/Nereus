// The agent routes with a stub in place of Doris: answer shapes, the export cap, unknown paths.

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { agentRoutes } from '../src/api/agents/routes.ts';
import type { Doris } from '../src/db/doris.ts';
import { MAX_EXPORT_BYTES, MAX_EXPORT_ROWS } from '../src/semantics/trajectory/export.ts';

/** A Doris that answers counts with `total` and everything else with `rows`, recording the SQL. */
function stub(total: number, rows: Record<string, unknown>[] = [], bytes = 0) {
  const seen: string[] = [];
  const doris = { query: async (sql: string) => { seen.push(sql); return sql.startsWith('SELECT count(*)') ? [{ total, bytes }] : rows; } } as unknown as Doris;
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

test('an export with too much text is refused before its rows are read', async () => {
  const { doris, seen } = stub(1, [], MAX_EXPORT_BYTES + 1);
  await assert.rejects(call(doris, `/api/agents/messages?${RANGE}&format=csv`).done, /more than 134217728 bytes/);
  assert.equal(seen.length, 1, 'only the count ran');
});

test('an export whose fetched rows exceed the cap is refused, not cut', async () => {
  const rows = Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => ({ a: 1 }));
  const { doris } = stub(1, rows);
  await assert.rejects(call(doris, `/api/agents/messages?${RANGE}&format=csv`).done, /at most 200000/);
});

test('paths outside the agent API are left to other routes; unknown agent paths answer 404', async () => {
  const { doris } = stub(0);
  assert.equal(await call(doris, '/api/search').done, false);
  const c = call(doris, '/api/agents/nothing');
  assert.equal(await c.done, true);
  assert.equal(c.answers[0]!.status, 404);
});

test('a malformed percent-escape in a session path answers 400', async () => {
  const { doris } = stub(0);
  await assert.rejects(call(doris, '/api/agents/sessions/%E0%A4%A').done, /bad session id/);
});

test('Compare accepts turn 0, the turn of events before the first user input', async () => {
  const { doris } = stub(0, [{ session_id: 'x' }, { session_id: 'y' }]);
  const c = call(doris, '/api/agents/compare?a=x&b=y&turn=0');
  assert.equal(await c.done, true);
  const a = c.answers[0]!;
  assert.equal(a.status, 200);
  assert.equal(a.body.sql[2].title, 'Steps of turn 0');
});

test('a conversations export over the byte cap is refused before its lines are built', async () => {
  const seen: string[] = [];
  const doris = {
    query: async (sql: string) => {
      seen.push(sql);
      const isSize = sql.startsWith('WITH') && sql.includes('count(DISTINCT session_id)');
      return isSize ? [{ bytes: MAX_EXPORT_BYTES + 1 }] : [];
    },
  } as unknown as Doris;
  await assert.rejects(call(doris, `/api/agents/sessions?${RANGE}&format=jsonl`).done, /more than 134217728 bytes/);
  assert.equal(seen.length, 1, 'only the size statement ran');
});

test('the conversations export cap is at most 128 MiB', () => {
  assert.ok(MAX_EXPORT_BYTES <= 128 * 1024 * 1024);
});

test('the size of a CSV export: rows, bytes, a preview and the statements, without reading the file', async () => {
  const { doris, seen } = stub(7, [{ session_id: 's', title: '=x' }], 99);
  const c = call(doris, `/api/agents/sessions?${RANGE}&format=csv&size=1`);
  assert.equal(await c.done, true);
  const a = c.answers[0]!;
  assert.deepEqual([a.status, a.body.size, a.body.sql.map((s: any) => s.title)], [200, { rows: 7, bytes: 99 }, ['Rows', 'Total']]);
  assert.ok(a.body.preview.startsWith('last_event_at,session_id,title,'));
  assert.match(a.body.preview, /\n,s,'=x,/);
  assert.ok(seen.some((s) => /LIMIT 5 OFFSET 0$/.test(s)), 'the preview reads five rows');
  assert.ok(!seen.some((s) => /LIMIT 200001$/.test(s)), 'the file itself is not read');
});

test('a session tree answers sessions, turns, marks and risks; every step only when the tree is small', async () => {
  const big = call(stub(0, [{ session_id: 's', kind: 'main', steps: 41 }]).doris, '/api/agents/sessions/s');
  assert.equal(await big.done, true);
  const a = big.answers[0]!;
  assert.deepEqual([a.status, a.body.openAll, a.body.steps, a.body.sql.map((s: any) => s.title)], [200, false, null, ['Session', 'Turns', 'Marks', 'Risks']]);
  assert.equal(a.body.marks.length, 1);
  // The stub answers one row to every statement: one risk, and with it the rules a page draws.
  assert.deepEqual([a.body.risks.length, a.body.risksCut, a.body.rules.map((r: any) => r.id)], [1, false, ['confirm', 'exfil', 'subvert', 'deny']]);
  const small = call(stub(0, [{ session_id: 's', kind: 'main', steps: 40 }]).doris, '/api/agents/sessions/s');
  await small.done;
  assert.deepEqual(small.answers[0]!.body.sql.map((s: any) => s.title), ['Session', 'Turns', 'Marks', 'Risks', 'Steps']);
  assert.equal(small.answers[0]!.body.steps.length, 1);
});

test('the Risks table is a table page like the others, with its export', async () => {
  const { doris, seen } = stub(3, [{ session_id: 's', rule: 'deny' }]);
  const c = call(doris, `/api/agents/risks?${RANGE}&q=sudo&f=rule:eq:deny&sort=turn&dir=asc`);
  await c.done;
  const a = c.answers[0]!;
  assert.deepEqual([a.status, a.body.total, a.body.rows, a.body.sql.map((s: any) => s.title)], [200, 3, [{ session_id: 's', rule: 'deny' }], ['Rows', 'Total']]);
  assert.ok(a.body.columns.some((x: any) => x.name === 'judgment' && x.kind === 'text'));
  assert.match(seen[0]!, /FROM otel\.agent_risks r\nJOIN otel\.agent_sessions s ON s\.session_id = r\.session_id\nJOIN otel\.agent_sessions m ON m\.session_id = r\.root_id\nWHERE m\.safety_risks IS NOT NULL/);
  assert.match(seen[0]!, /\(r\.what MATCH_PHRASE 'sudo' OR r\.rule_name MATCH_PHRASE 'sudo'\)\n {2}AND r\.rule = 'deny'\nORDER BY r\.turn ASC, r\.session_id, r\.rule, r\.first_seq\nLIMIT 100 OFFSET 0$/);
  const file = call(stub(1, [{ session_id: 's', rule: 'deny', what: '=cmd' }]).doris, `/api/agents/risks?${RANGE}&format=csv&size=1`);
  await file.done;
  assert.match(file.answers[0]!.body.preview, /^ts,session_id,root_id,title,agent,turn,judgment,rule,rule_name,what,why,first_seq,rule_version,found_at\n/);
});

test('Compare with a turn answers both sides, their pairs and their compactions', async () => {
  const rows = [
    { session_id: 'x', seq: 2, step: 1, kind: 'llm_call', tools: 'Read', targets: 'a', failed: 0, ctx_tokens: 10 },
    { session_id: 'x', seq: 4, step: 1, kind: 'compaction', tools: 'reply', targets: '', failed: 0, ctx_tokens: 0 },
    { session_id: 'y', seq: 2, step: 1, kind: 'llm_call', tools: 'Read', targets: 'a', failed: 1, ctx_tokens: 20 },
  ];
  const c = call(stub(0, rows).doris, '/api/agents/compare?a=x&b=y&turn=1');
  await c.done;
  assert.deepEqual(c.answers[0]!.body.steps, {
    a: [{ seq: 2, step: 1, tools: 'Read', targets: 'a', failed: false, ctx: 10 }],
    b: [{ seq: 2, step: 1, tools: 'Read', targets: 'a', failed: true, ctx: 20 }],
    rows: [{ a: 0, b: 0, differs: true }],
    cuts: { a: [{ seq: 4, after: 0 }], b: [] },
  });
});

test('a tree with more marks than the limit answers the first 2000 and says they were cut', async () => {
  const many = Array.from({ length: 2001 }, (_, i) => ({ session_id: 's', kind: 'main', steps: 41, seq: i }));
  const cut = call(stub(0, many).doris, '/api/agents/sessions/s');
  await cut.done;
  assert.deepEqual([cut.answers[0]!.body.marks.length, cut.answers[0]!.body.marksCut], [2000, true]);
  const whole = call(stub(0, [{ session_id: 's', kind: 'main', steps: 41 }]).doris, '/api/agents/sessions/s');
  await whole.done;
  assert.equal(whole.answers[0]!.body.marksCut, false);
});
