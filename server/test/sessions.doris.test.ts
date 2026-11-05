// Client sessions end to end on a live Doris (otel_sessions from schema/002_sessions.sql) and a
// fresh PostgreSQL: ingestion keys, CORS, ingest, list, detail. Skipped unless DORIS_TEST=1.
//
//   DORIS_TEST=1 DORIS_PORT=9930 DORIS_DB=otel_bench node --test test/sessions.doris.test.ts

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { AuthStore } from '../src/auth/store.ts';
import { ContentStore } from '../src/content/store.ts';
import { Doris, configFromEnv } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { IngestKeys } from '../src/sessions/http.ts';
import { freshMetaDb } from './meta-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const skip = !enabled;
const db = process.env.DORIS_DB ?? 'otel_bench';
let base = '';
let admin = '';
let member = '';
let doris: Doris;
let close: () => Promise<void> = async () => {};

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  const meta = await freshMetaDb();
  const auth = new AuthStore(meta.pool);
  const a = await auth.setup('admin@example.com', 'Admin', 'adminpass1');
  const m = await auth.createUser('mia@example.com', 'Mia', 'memberpass', 'member');
  admin = (await auth.createApiKey(a.id, 't')).key;
  member = (await auth.createApiKey(m.id, 't')).key;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await doris.close();
    await meta.drop();
  };
});
after(() => close());

async function call(method: string, path: string, key: string, body?: unknown, type = 'application/json') {
  const res = await fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': type }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('ingestion keys: admins only, write-only, revocable; CORS for any page', { skip }, async () => {
  assert.equal((await call('POST', '/api/ingest-keys', member, { name: 'shop' })).status, 403);
  const made = await call('POST', '/api/ingest-keys', admin, { name: 'shop' });
  assert.equal(made.status, 201);
  const key = made.body.key as string;
  assert.match(key, /^dsi_/);
  assert.equal((await call('GET', '/api/ingest-keys', admin)).body.keys[0].name, 'shop');
  assert.equal((await call('GET', '/api/fields?source=logs', key)).status, 401, 'an ingestion key reads nothing');
  assert.equal((await call('GET', '/api/sessions?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z', key)).status, 401);
  const body = { sessionId: `s_${randomUUID().slice(0, 8)}`, events: [{ t: Date.now(), type: 'custom', message: 'hello' }] };
  assert.equal((await call('POST', '/api/ingest/sessions', admin, body)).status, 401, 'an API key does not ingest');
  const pre = await fetch(`${base}/api/ingest/sessions`, { method: 'OPTIONS', headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers')!, /authorization/);
  assert.equal(pre.headers.get('access-control-allow-credentials'), null, 'no cookies cross origins');
  const ok = await call('POST', '/api/ingest/sessions', key, body);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  // Without a preflight: text/plain and the key in the query string (sendBeacon on page hide).
  const beacon = await fetch(`${base}/api/ingest/sessions?key=${key}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  assert.equal(beacon.status, 200);
  assert.equal((await call('POST', '/api/ingest/sessions', key, { sessionId: 'bad id!' })).status, 400);
  await call('DELETE', `/api/ingest-keys/${made.body.id}`, admin);
  assert.equal((await call('POST', '/api/ingest/sessions', key, body)).status, 401, 'revoked');
});

test('a session round-trips: replay chunks byte for byte, events, the list and its search', { skip }, async () => {
  const key = (await call('POST', '/api/ingest-keys', admin, { name: 'shop2' })).body.key;
  const sid = `s_${randomUUID().replace(/-/g, '')}`;
  const t0 = Date.now() - 60_000;
  // A full snapshot over two payload parts, with text that SQL escaping must keep intact.
  const tricky = `it's "quoted" \\ back\\slash \n new line \u0000 nul 😀 ${'x'.repeat(250_000)} end`;
  const chunk1 = [{ type: 4, timestamp: t0, data: { href: 'https://shop.example.com/' } }, { type: 2, timestamp: t0 + 1, data: { node: { text: tricky } } }];
  const chunk2 = [{ type: 3, timestamp: t0 + 5000, data: { source: 2, type: 2, id: 7, x: 10, y: 20 } }];
  const user = { id: 'u42', email: 'ada@example.com', name: 'Ada' };
  const r1 = await call('POST', '/api/ingest/sessions', key, {
    sessionId: sid, service: 'shop-web', userAgent: 'Mozilla/5.0 test', user,
    replay: [{ seq: 0, t: t0, events: chunk1 }],
    events: [{ t: t0, type: 'navigation', url: 'https://shop.example.com/', message: 'Shop' }],
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.ok(r1.body.rows >= 3, 'the big chunk is split');
  await call('POST', '/api/ingest/sessions', key, {
    sessionId: sid, service: 'shop-web', user, replay: [{ seq: 1, t: t0 + 5000, events: chunk2 }],
    events: [
      { t: t0 + 5000, type: 'click', url: 'https://shop.example.com/', message: 'button#buy "Buy now"' },
      { t: t0 + 6000, type: 'network', url: 'https://shop.example.com/', message: 'POST /api/cart 500', attributes: { status: 500, duration_ms: 87 } },
      { t: t0 + 6100, type: 'error', url: 'https://shop.example.com/', message: 'Error: cart failed', attributes: { stack: 'at buy (app.js:1:2)' } },
    ],
  });
  const from = new Date(t0 - 60_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
  const list = await call('GET', `/api/sessions?from=${from}&to=${to}&where=${encodeURIComponent('type:error "cart failed"')}`, member);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const s = list.body.sessions.find((x: any) => x.session_id === sid);
  assert.ok(s, 'found by its error');
  assert.deepEqual([s.user_email, s.service, s.first_url, Number(s.clicks), Number(s.errors), Number(s.pages), Number(s.requests)],
    ['ada@example.com', 'shop-web', 'https://shop.example.com/', 1, 2, 1, 1], 'the 500 counts as an error too');
  const none = await call('GET', `/api/sessions?from=${from}&to=${to}&where=${encodeURIComponent('email:nobody@example.com')}`, member);
  assert.ok(!none.body.sessions.some((x: any) => x.session_id === sid));

  const detail = await call('GET', `/api/sessions/${sid}?from=${from}&to=${to}`, member);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.replay, [chunk1, chunk2], 'replay chunks come back exactly');
  assert.deepEqual(detail.body.events.map((e: any) => e.type), ['navigation', 'click', 'network', 'error']);
  assert.equal(detail.body.events[2].attributes.status, 500);
  assert.deepEqual(detail.body.session.user, user);
  assert.equal((await call('GET', `/api/sessions/${sid}?from=${from}`, member)).status, 400);
  assert.equal((await call('GET', `/api/sessions/s_doesnotexist?from=${from}&to=${to}`, member)).status, 404);
});
