// The trajectory tools over HTTP on a live Doris and PostgreSQL, as an agent's MCP client calls them
// with an API key: the handshake, the list of tools, a search that finds a session by its words, a
// read of that session, of a turn and of a step, and a call without a key. Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importFile } from '../src/cli/import-transcripts.ts';
import { AuthStore } from '../src/control/auth/store.ts';
import { ContentStore } from '../src/control/content/store.ts';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../src/db/stream-load.ts';
import { IngestKeys } from '../src/rum/http.ts';
import { createApp } from '../src/server.ts';
import { READER_ID, writeMemorySessions } from './fixtures/memory-transcript.ts';
import { freshMetaDb } from './meta-helper.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_mcp_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let base = '';
let key = '';
let dir = '';
let close: () => Promise<void> = async () => {};

before(async () => {
  if (!enabled) return;
  const doris = new Doris(configFromEnv());
  let drop = async () => {};
  let stop = async () => {};
  close = async () => {
    await stop();
    await drop();
    try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
  };
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  dir = mkdtempSync(join(tmpdir(), 'nereus-mcp-'));
  for (const file of writeMemorySessions(dir)) await importFile(file, { doris, db, load: (t, l, r) => streamLoad(cfg, db, t, l, r) });
  const meta = await freshMetaDb();
  drop = () => meta.drop();
  const auth = new AuthStore(meta.pool);
  const admin = await auth.setup('admin@example.com', 'Ada', 'adminpass1');
  key = (await auth.createApiKey(admin.id, 'agent')).key;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stop = () => new Promise<void>((r) => server.close(() => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let id = 0;
async function rpc(method: string, params: Record<string, unknown> = {}, auth = true) {
  const res = await fetch(`${base}/api/agents/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params }),
  });
  return { status: res.status, body: await res.json() as any };
}
const tool = async (name: string, args: Record<string, unknown>) => JSON.parse((await rpc('tools/call', { name, arguments: args })).body.result.content[0].text);

test('an MCP client with an API key does the handshake and sees two read-only tools', { skip: !enabled }, async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.deepEqual([init.status, init.body.result.protocolVersion, init.body.result.serverInfo.name], [200, '2025-06-18', 'nereus-trajectories']);
  const listed = await rpc('tools/list');
  assert.deepEqual(listed.body.result.tools.map((t: any) => [t.name, t.annotations.readOnlyHint]), [['trajectory_search', true], ['trajectory_read', true]]);
  assert.equal((await rpc('ping', {}, false)).status, 401, 'no key, no tools');
});

test('a search finds a session by its words, and a read answers its turns, a turn and a step', { skip: !enabled }, async () => {
  const found = await tool('trajectory_search', { table: 'sessions', q: 'staging', from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' });
  assert.deepEqual([found.total, found.rows.map((r: any) => r.session_id)], [1, [READER_ID]]);
  const whole = await tool('trajectory_read', { session_id: READER_ID });
  assert.deepEqual([whole.sessions.length, whole.turns.length, whole.turns[0].user_input], [1, 1, 'Why does the deploy pipeline take so long on the staging machines?']);
  const turn = await tool('trajectory_read', { session_id: READER_ID, turn: 1 });
  assert.ok(turn.steps.length >= 1 && turn.steps.every((g: any) => g.events[0].kind === 'llm_call'), JSON.stringify(turn.steps).slice(0, 300));
  assert.ok(turn.steps.flatMap((g: any) => g.events).some((e: any) => e.kind === 'tool_call' && e.name === 'Read'), 'each model call comes with its tool calls');
  const steps = await tool('trajectory_search', { table: 'steps', conditions: [`session_id:eq:${READER_ID}`], from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' });
  const step = await tool('trajectory_read', { session_id: READER_ID, seq: Number(steps.rows.at(-1).seq) });
  assert.equal(step.seq, Number(steps.rows.at(-1).seq));
  const wrong = await rpc('tools/call', { name: 'trajectory_read', arguments: { session_id: 'no-such-session' } });
  assert.deepEqual([wrong.body.result.isError, wrong.body.result.content[0].text], [true, 'no such session']);
});
