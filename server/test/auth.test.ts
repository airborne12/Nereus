// Password hashing (always) and the auth endpoints against a real PostgreSQL (PG_TEST=1).

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { hashPassword, newToken, tokenHash, verifyPassword } from '../src/auth/secrets.ts';
import { ContentStore } from '../src/content/store.ts';
import { AuthStore } from '../src/auth/store.ts';
import { Doris, configFromEnv } from '../src/db.ts';
import { migrate } from '../src/meta.ts';
import { createApp } from '../src/server.ts';
import { freshMetaDb, pgEnabled } from './meta-helper.ts';

test('passwords hash with a salt and verify', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('correct horsf', a), false);
});

test('tokens are 256-bit and hash to 32 bytes', () => {
  const t = newToken('dsk');
  assert.match(t, /^dsk_[\w-]{43}$/);
  assert.equal(tokenHash(t).length, 32);
  assert.notEqual(newToken('dsk'), t);
});

let base = '';
let stop: () => Promise<void> = async () => {};
let store: AuthStore;

before(async () => {
  if (!pgEnabled) return;
  const meta = await freshMetaDb();
  assert.deepEqual(await migrate(meta.pool), [], 'migrations are applied once');
  store = new AuthStore(meta.pool);
  // Doris is never reached by these tests; the pool connects lazily.
  const doris = new Doris({ ...configFromEnv(), port: 1 });
  const webDir = new URL('../../web/dist', import.meta.url).pathname;
  const server = createApp({ doris, db: 'otel', auth: { store, secureCookie: false }, content: new ContentStore(meta.pool), webDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await doris.close();
    await meta.drop();
  };
});
after(() => stop());

type Res = { status: number; body: any; cookie: string | null };
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string | null; bearer?: string; type?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = opts.type ?? 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const set = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json(), cookie: set ? set.split(';')[0]! : null };
}

const skip = !pgEnabled;
let adminCookie: string | null = null;

test('setup creates the first admin once and logs them in', { skip }, async () => {
  assert.deepEqual((await call('GET', '/api/auth/status')).body, { setupRequired: true, user: null });
  assert.equal((await call('POST', '/api/auth/setup', { body: { email: 'a@x.io', password: 'short' } })).status, 400);
  const first = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Ada', password: 'adminpass1' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.user.role, 'admin');
  assert.match(first.cookie!, /^ds_session=dss_/);
  adminCookie = first.cookie;
  const again = await call('POST', '/api/auth/setup', { body: { email: 'b@example.com', password: 'adminpass2' } });
  assert.equal(again.status, 409);
  const status = await call('GET', '/api/auth/status', { cookie: adminCookie });
  assert.equal(status.body.setupRequired, false);
  assert.equal(status.body.user.email, 'admin@example.com');
});

test('concurrent setups create exactly one admin', { skip }, async () => {
  const meta = await freshMetaDb();
  const s = new AuthStore(meta.pool);
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => s.setup(`u${i}@example.com`, '', 'password1')));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await s.userCount(), 1);
  await meta.drop();
});

test('malformed or escaping static paths are refused', { skip }, async () => {
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  // Encoded ../ collapses inside the UI directory: the answer is the app, never a file outside it.
  const escape = await fetch(`${base}/..%2f..%2f..%2f..%2fetc%2fpasswd`);
  const text = await escape.text();
  assert.equal(escape.status, 200);
  assert.match(text, /<div id="root">/);
  assert.doesNotMatch(text, /root:x:/);
});

test('data endpoints need a login', { skip }, async () => {
  const r = await call('GET', '/api/search?source=logs&q=&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z');
  assert.equal(r.status, 401);
  assert.equal((await call('GET', '/api/keys', { cookie: 'ds_session=dss_forged' })).status, 401);
  assert.equal((await call('GET', '/api/keys', { bearer: 'dsk_forged' })).status, 401);
  assert.equal((await call('GET', '/api/keys', { bearer: 'not a key' })).status, 401);
});

test('state-changing requests must be JSON', { skip }, async () => {
  const r = await call('POST', '/api/auth/login', { body: 'email=admin@example.com&password=adminpass1', type: 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
  assert.equal((await call('POST', '/api/keys', { cookie: adminCookie, body: 'x', type: 'text/plain' })).status, 415);
});

test('login: wrong password, case-insensitive email, logout ends the session', { skip }, async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'nope-nope' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'adminpass1' } })).status, 401);
  const ok = await call('POST', '/api/auth/login', { body: { email: 'ADMIN@example.com', password: 'adminpass1' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/keys', { cookie: ok.cookie })).status, 200);
  const out = await call('POST', '/api/auth/logout', { cookie: ok.cookie, body: {} });
  assert.match(out.cookie!, /^ds_session=$/);
  assert.equal((await call('GET', '/api/keys', { cookie: ok.cookie })).status, 401);
});

test('repeated failed logins are throttled', { skip }, async () => {
  const body = { email: 'throttle@example.com', password: 'wrongwrong' };
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await call('POST', '/api/auth/login', { body })).status);
  assert.deepEqual(codes, [...Array(10).fill(401), 429]);
});

test('API keys: shown once, work as bearer tokens, revocation stops them', { skip }, async () => {
  const created = await call('POST', '/api/keys', { cookie: adminCookie, body: { name: 'ci' } });
  assert.equal(created.status, 201);
  const key = created.body.key as string;
  assert.match(key, /^dsk_/);
  assert.equal(created.body.apiKey.prefix, key.slice(0, 12));
  const list = await call('GET', '/api/keys', { bearer: key });
  assert.equal(list.status, 200);
  assert.equal(list.body.keys.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(key), 'the key itself is never listed');
  assert.ok(list.body.keys[0].lastUsedAt, 'last use is recorded');
  assert.equal((await call('DELETE', `/api/keys/${created.body.apiKey.id}`, { cookie: adminCookie })).status, 200);
  assert.equal((await call('GET', '/api/keys', { bearer: key })).status, 401);
});

test('admins manage users; members cannot; disabling ends sessions and keys', { skip }, async () => {
  const made = await call('POST', '/api/users', { cookie: adminCookie, body: { email: 'mia@example.com', name: 'Mia', password: 'memberpass' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.role, 'member');
  assert.equal((await call('POST', '/api/users', { cookie: adminCookie, body: { email: 'MIA@example.com', password: 'memberpass' } })).status, 409);
  const mia = await call('POST', '/api/auth/login', { body: { email: 'mia@example.com', password: 'memberpass' } });
  assert.equal((await call('GET', '/api/users', { cookie: mia.cookie })).status, 403);
  const key = (await call('POST', '/api/keys', { cookie: mia.cookie, body: { name: 'mine' } })).body.key;

  const id = made.body.user.id;
  assert.equal((await call('POST', `/api/users/${id}/disabled`, { cookie: adminCookie, body: { disabled: true } })).status, 200);
  assert.equal((await call('GET', '/api/keys', { cookie: mia.cookie })).status, 401);
  assert.equal((await call('GET', '/api/keys', { bearer: key })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'mia@example.com', password: 'memberpass' } })).status, 401);
  await call('POST', `/api/users/${id}/disabled`, { cookie: adminCookie, body: { disabled: false } });
  assert.equal((await call('GET', '/api/keys', { bearer: key })).status, 200, 'keys work again once re-enabled');

  const me = (await call('GET', '/api/auth/status', { cookie: adminCookie })).body.user.id;
  assert.equal((await call('POST', `/api/users/${me}/disabled`, { cookie: adminCookie, body: { disabled: true } })).status, 400);
});
