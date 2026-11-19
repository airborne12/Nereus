// The MCP endpoint of the trajectory tools with a stub in place of Doris: a request is answered with
// one JSON-RPC message, a notification with 202 and no body, a GET with 405.

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { agentRoutes } from '../src/api/agents/routes.ts';
import type { Doris } from '../src/db/doris.ts';

const doris = { query: async (sql: string) => (sql.startsWith('SELECT count(*)') ? [{ total: 1, bytes: 0 }] : [{ session_id: 's-1' }]) } as unknown as Doris;

function call(method: string, body?: unknown) {
  const answers: { status: number; body: unknown; headers?: Record<string, string | string[]> }[] = [];
  const written: number[] = [];
  const routes = agentRoutes({ doris, db: 'otel', send: (_res, status, b, headers) => answers.push({ status, body: b, headers }) });
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
  const res = { writeHead: (s: number) => { written.push(s); return res; }, end: () => undefined } as unknown as ServerResponse;
  return { done: routes.handle(req, res, new URL('http://x/api/agents/mcp')), answers, written };
}

test('a request gets one JSON-RPC answer; a tool call runs the tool', async () => {
  const init = call('POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(await init.done, true);
  assert.equal(init.answers[0]!.status, 200);
  assert.equal((init.answers[0]!.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'nereus-trajectories');
  const search = call('POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trajectory_search', arguments: { table: 'sessions' } } });
  await search.done;
  const text = (search.answers[0]!.body as { result: { content: { text: string }[] } }).result.content[0]!.text;
  assert.deepEqual([JSON.parse(text).total, JSON.parse(text).rows], [1, [{ session_id: 's-1' }]]);
});

test('a notification gets 202 and no body; a GET is not offered', async () => {
  const note = call('POST', { jsonrpc: '2.0', method: 'notifications/initialized' });
  await note.done;
  assert.deepEqual([note.written, note.answers], [[202], []]);
  const get = call('GET');
  await get.done;
  assert.deepEqual([get.answers[0]!.status, get.answers[0]!.headers], [405, { Allow: 'POST' }]);
});
