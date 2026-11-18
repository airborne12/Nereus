// The agent API on a live Doris: the hand-written fixture imported twice (the second copy with its
// failing call fixed, for Compare), then every endpoint checked against values worked out from the
// fixture by hand. Skipped unless DORIS_TEST=1; needs DORIS_BE_HTTP_URL and PostgreSQL.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { AGENT_FILE_ID, MAIN_ID, writeFixture } from './fixtures/claude-transcript.ts';
import { freshMetaDb } from './meta-helper.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_agent_api_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const OTHER = 'fx-main-0002';
const RANGE = 'from=2026-11-17T00:00:00Z&to=2026-11-18T00:00:00Z';
let doris: Doris;
let base = '';
let key = '';
let dir = '';
let close: () => Promise<void> = async () => {};

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-agent-api-'));
  const main = writeFixture(dir);
  await importFile(main, { doris, db, load });
  // The same session with its failing test run passing, and no sub-agent folder.
  const other = join(dir, `${OTHER}.jsonl`);
  writeFileSync(other, readFileSync(main, 'utf8').replace('"is_error":true', '"is_error":false'));
  await importFile(other, { doris, db, load });
  const meta = await freshMetaDb();
  const auth = new AuthStore(meta.pool);
  const admin = await auth.setup('admin@example.com', 'Admin', 'adminpass1');
  key = (await auth.createApiKey(admin.id, 't')).key;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await meta.drop();
  };
});
after(async () => {
  await close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
});

async function get(path: string): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* a file */ }
  return { status: res.status, body, text, headers: res.headers };
}

test('Sessions: main sessions with tree totals; search, conditions and sort', { skip: !enabled }, async () => {
  const all = await get(`/api/agents/sessions?${RANGE}&sort=session_id&dir=asc`);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2);
  const m = all.body.rows[0];
  assert.deepEqual([m.session_id, m.title, Number(m.steps), Number(m.tool_errors), Number(m.tokens), Number(m.subagents)],
    [MAIN_ID, 'Fix the clock test', 7, 1, 210, 1]);
  assert.equal(m.first_input, 'Fix the failing test in tests/clock_test.py 😀');
  assert.ok(all.body.sql.length === 2 && typeof all.body.elapsedMs === 'number');
  assert.equal((await get(`/api/agents/sessions?${RANGE}&q=clock`)).body.total, 2);
  assert.equal((await get(`/api/agents/sessions?${RANGE}&q=${encodeURIComponent('"public API"')}`)).body.total, 2);
  assert.equal((await get(`/api/agents/sessions?${RANGE}&q=zebra`)).body.total, 0);
  assert.equal((await get(`/api/agents/sessions?${RANGE}&f=tool_errors:gt:0`)).body.total, 1);
  assert.equal((await get(`/api/agents/sessions?${RANGE}&f=first_input:contains:failing`)).body.total, 2);
  assert.equal((await get(`/api/agents/sessions?from=2026-11-18T00:00:00Z&to=2026-11-19T00:00:00Z`)).body.total, 0);
});

test('Steps and Messages: rows, search on what the assistant wrote, role retrieval', { skip: !enabled }, async () => {
  const steps = await get(`/api/agents/steps?${RANGE}&f=session_id:eq:${MAIN_ID}&sort=seq&dir=asc`);
  assert.deepEqual(steps.body.rows.map((r: any) => [Number(r.seq), r.status, r.repeated_call, Number(r.retries)]),
    [[2, 'failed', '', 0], [5, 'ok', 'still in context', 0], [7, 'ok', '', 0], [10, 'ok', '', 1], [13, 'ok', '', 0]]);
  assert.equal(steps.body.rows[0].calls, 'Read tests/clock_test.py, Bash pytest tests/clock_test.py');
  assert.equal((await get(`/api/agents/steps?${RANGE}`)).body.total, 12);
  assert.equal((await get(`/api/agents/steps?${RANGE}&f=session_id:eq:${MAIN_ID}&q=read`)).body.total, 2);
  const msgs = await get(`/api/agents/messages?${RANGE}&f=session_id:eq:${MAIN_ID}&f=msg_role:eq:assistant`);
  assert.equal(msgs.body.total, 7);
  assert.equal((await get(`/api/agents/messages?${RANGE}&f=session_id:ne:${OTHER}&q=utc`)).body.total, 6);
  assert.equal((await get(`/api/agents/messages?${RANGE}&f=session_id:eq:${MAIN_ID}&q=${encodeURIComponent('😀')}`)).body.total, 1);
});

test('bad requests answer 400', { skip: !enabled }, async () => {
  for (const q of ['f=nope:eq:1', 'f=steps:like:1', 'f=steps:gt:many', 'sort=nope', 'dir=up', 'limit=0', 'format=xml']) {
    const r = await get(`/api/agents/sessions?${RANGE}&${q}`);
    assert.equal(r.status, 400, q);
  }
  assert.equal((await get('/api/agents/sessions?q=x')).status, 400);
  assert.equal((await get(`/api/agents/steps?${RANGE}&format=jsonl`)).status, 400);
});

test('session page: tree, turns, all steps of a small tree; a sub-agent id opens its tree', { skip: !enabled }, async () => {
  const s = await get(`/api/agents/sessions/${MAIN_ID}`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.sessions.map((x: any) => [x.session_id, x.kind, x.parent_seq === null ? null : Number(x.parent_seq)]),
    [[MAIN_ID, 'main', null], [AGENT_FILE_ID, 'subagent', 8]]);
  const t1 = s.body.turns.find((t: any) => t.session_id === MAIN_ID && Number(t.turn) === 1);
  assert.deepEqual([Number(t1.steps), Number(t1.failed_calls), t1.tools], [4, 1, 'Read,Bash failed,Read,Agent']);
  assert.equal(s.body.turns.length, 3);
  assert.equal(s.body.openAll, true);
  assert.equal(s.body.steps.length, 13);
  const sub = await get(`/api/agents/sessions/${AGENT_FILE_ID}`);
  assert.equal(sub.body.sessions.length, 2);
  assert.equal((await get('/api/agents/sessions/nobody')).status, 404);
  assert.equal((await get('/api/agents/sessions/bad%20id')).status, 400);
});

test('turns: one page of steps, the input and the final answer', { skip: !enabled }, async () => {
  const p = await get(`/api/agents/sessions/${MAIN_ID}/turns/1/steps`);
  assert.deepEqual(p.body.steps.map((x: any) => Number(x.seq)), [2, 3, 4, 5, 6, 7, 8, 10]);
  assert.deepEqual((await get(`/api/agents/sessions/${MAIN_ID}/turns/1/steps?offset=3`)).body.steps.map((x: any) => Number(x.seq)), [10]);
  assert.deepEqual((await get(`/api/agents/sessions/${MAIN_ID}/turns/2/steps`)).body.steps.map((x: any) => x.kind), ['compaction', 'llm_call']);
  const t = await get(`/api/agents/sessions/${MAIN_ID}/turns/1`);
  assert.deepEqual(t.body.blocks.map((b: any) => [Number(b.msg_seq), b.msg_role]), [[1, 'user'], [12, 'assistant']]);
});

test('step: input latest first, output with tool results, prompt', { skip: !enabled }, async () => {
  const s = await get(`/api/agents/sessions/${MAIN_ID}/steps/5`);
  assert.equal(s.status, 200);
  assert.deepEqual([s.body.inputTotal, s.body.inputNew], [7, 5]);
  assert.deepEqual(s.body.input.map((b: any) => Number(b.msg_seq)), [7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(s.body.output.map((b: any) => [Number(b.msg_seq), b.kind]), [[8, 'tool_use'], [9, 'tool_result']]);
  assert.deepEqual(s.body.output[0].payload, { file_path: 'tests/clock_test.py' });
  assert.deepEqual([s.body.prompt.system_text, s.body.prompt.tool_names], ['You are a coding agent.', ['Read', 'Bash']]);
  assert.equal((await get(`/api/agents/sessions/${MAIN_ID}/steps/3`)).status, 404, 'seq 3 is a tool call');
  assert.equal((await get(`/api/agents/sessions/${AGENT_FILE_ID}/steps/2`)).body.prompt, null, 'no request log, no prompt');
});

test('compaction: the replaced blocks and the summary', { skip: !enabled }, async () => {
  const c = await get(`/api/agents/sessions/${MAIN_ID}/events/12/compaction`);
  assert.equal(c.body.event.attrs.trigger, 'auto');
  assert.deepEqual(c.body.replaced.map((b: any) => Number(b.msg_seq)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(c.body.summary.map((b: any) => b.kind), ['summary']);
  assert.equal((await get(`/api/agents/sessions/${MAIN_ID}/events/11/compaction`)).status, 404);
});

test('compare: steps paired by tool; the fixed call differs in outcome', { skip: !enabled }, async () => {
  const c = await get(`/api/agents/compare?a=${MAIN_ID}&b=${OTHER}&turn=1`);
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.steps.rows, [
    { a: 0, b: 0, differs: true }, { a: 1, b: 1, differs: false }, { a: 2, b: 2, differs: false }, { a: 3, b: 3, differs: false },
  ]);
  assert.equal((await get(`/api/agents/compare?a=${MAIN_ID}&b=${OTHER}`)).body.steps, null);
  assert.equal((await get(`/api/agents/compare?a=${MAIN_ID}&b=nobody`)).status, 404);
});

test('exports: CSV of a table page, conversations as JSON lines, and the size with a preview', { skip: !enabled }, async () => {
  const csv = await get(`/api/agents/sessions?${RANGE}&format=csv&sort=session_id&dir=asc`);
  assert.match(csv.headers.get('content-disposition')!, /attachment; filename="agent-sessions-\d{14}\.csv"/);
  const lines = csv.text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.startsWith('last_event_at,session_id,title,'));
  const conv = await get(`/api/agents/sessions?${RANGE}&f=session_id:eq:${MAIN_ID}&format=jsonl`);
  const parts = conv.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(parts.map((p) => [p.session_id, p.part, p.messages.length]), [[MAIN_ID, 1, 11], [MAIN_ID, 2, 4], [AGENT_FILE_ID, 1, 4]]);
  assert.deepEqual(parts[1].messages.map((m: any) => m.role), ['system', 'user', 'user', 'assistant']);
  assert.equal(parts[1].messages[1].summary, true);
  const size = await get(`/api/agents/sessions?${RANGE}&f=session_id:eq:${MAIN_ID}&format=jsonl&size=1`);
  assert.deepEqual([Number(size.body.size.sessions), Number(size.body.size.parts), Number(size.body.size.blocks)], [2, 3, 19]);
  assert.ok(size.body.preview.every((l: any) => l.messages.length <= 6));
});

test('agent tables are query sources for search and charts', { skip: !enabled }, async () => {
  const r = await get(`/api/search?source=agent_messages&${RANGE}&q=${encodeURIComponent(`role:tool AND utc AND session:${MAIN_ID}`)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 2);
  const e = await get(`/api/search?source=agent_events&${RANGE}&q=${encodeURIComponent('kind:tool_call AND status:error')}`);
  assert.equal(e.body.rows.length, 1);
  const f = await get('/api/fields?source=agent_sessions');
  assert.ok(f.body.fields.some((x: any) => x.name === 'first_input'));
});
