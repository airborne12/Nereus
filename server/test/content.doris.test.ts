// Saved searches, dashboards, webhooks, alerts and charts through the HTTP API, on a fresh
// PostgreSQL database and a live Doris loaded by bench/otelgen.py. Skipped unless DORIS_TEST=1.

import { IngestKeys } from '../src/sessions/http.ts';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { AuthStore } from '../src/auth/store.ts';
import { AlertRunner } from '../src/content/alerts.ts';
import { ContentStore } from '../src/content/store.ts';
import { Doris, configFromEnv } from '../src/db.ts';
import { createApp, sourcesFor } from '../src/server.ts';
import { freshMetaDb } from './meta-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = process.env.DORIS_DB ?? 'otel_bench';
let base = '';
let hookUrl = '';
let admin = '';
let member = '';
let content: ContentStore;
let doris: Doris;
const received: any[] = [];
let close: () => Promise<void> = async () => {};

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  const meta = await freshMetaDb();
  const auth = new AuthStore(meta.pool);
  content = new ContentStore(meta.pool);
  const a = await auth.setup('admin@example.com', 'Admin', 'adminpass1');
  const m = await auth.createUser('mia@example.com', 'Mia', 'memberpass', 'member');
  admin = (await auth.createApiKey(a.id, 't')).key;
  member = (await auth.createApiKey(m.id, 't')).key;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content, ingestKeys: new IngestKeys(meta.pool) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A webhook receiver, like a Slack incoming webhook.
  const hook: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(req.url === '/fail' ? 500 : 200).end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => hook.close(() => r()));
    await doris.close();
    await meta.drop();
  };
});
after(() => close());

async function call(method: string, path: string, key = admin, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const skip = !enabled;
let searchId = 0;

test('saved searches: create, list with the creator, update, favorite per user, validate', { skip }, async () => {
  const made = await call('POST', '/api/saved-searches', member, {
    name: 'Payment errors', source: 'logs', where: 'level:error', filters: [{ field: 'service', values: ['payment'] }], tags: ['payments', 'oncall'],
  });
  assert.equal(made.status, 201);
  searchId = made.body.id;
  assert.equal(made.body.createdBy, 'Mia');
  assert.deepEqual(made.body.tags, ['payments', 'oncall']);
  const list = await call('GET', '/api/saved-searches');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].favorite, false);
  await call('POST', `/api/saved-searches/${searchId}/favorite`, admin, { on: true });
  assert.equal((await call('GET', `/api/saved-searches/${searchId}`)).body.favorite, true);
  assert.equal((await call('GET', `/api/saved-searches/${searchId}`, member)).body.favorite, false, 'favorites are per user');
  const upd = await call('PUT', `/api/saved-searches/${searchId}`, admin, { ...made.body, where: 'level:error OR level:warn' });
  assert.equal(upd.body.where, 'level:error OR level:warn');
  for (const bad of [{ name: '', source: 'logs' }, { name: 'x', source: 'metrics' }, { name: 'x', source: 'logs', filters: [{ field: 'a' }] },
    { name: 'x', source: 'logs', language: 'pg' }]) {
    assert.equal((await call('POST', '/api/saved-searches', admin, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('GET', '/api/saved-searches/999999')).status, 404);
});

let hookId = 0;

test('webhooks: admins only; members see names, not URLs; test message', { skip }, async () => {
  assert.equal((await call('POST', '/api/webhooks', member, { name: 'ops', url: hookUrl })).status, 403);
  assert.equal((await call('POST', '/api/webhooks', admin, { name: 'ops', url: 'ftp://x' })).status, 400);
  const made = await call('POST', '/api/webhooks', admin, { name: 'ops', url: `${hookUrl}/hook` });
  assert.equal(made.status, 201);
  hookId = made.body.id;
  assert.equal((await call('GET', '/api/webhooks', admin)).body.items[0].url, `${hookUrl}/hook`);
  assert.deepEqual(Object.keys((await call('GET', '/api/webhooks', member)).body.items[0]).sort(), ['createdAt', 'id', 'name']);
  assert.equal((await call('POST', `/api/webhooks/${hookId}/test`, admin, {})).status, 200);
  assert.equal(received.at(-1).text, '[TEST] Nereus webhook test');
  const failing = await call('POST', '/api/webhooks', admin, { name: 'broken', url: `${hookUrl}/fail` });
  assert.equal((await call('POST', `/api/webhooks/${failing.body.id}/test`, admin, {})).status, 502);
});

test('alerts fire on entering ALERT, resolve on leaving it, and keep a history', { skip }, async () => {
  const made = await call('POST', '/api/alerts', member, { savedSearchId: searchId, webhookId: hookId, thresholdType: 'above', threshold: 5, intervalSeconds: 3600 });
  assert.equal(made.status, 201);
  assert.equal(made.body.state, 'OK');
  assert.equal((await call('POST', '/api/alerts', member, { savedSearchId: searchId, webhookId: hookId, thresholdType: 'up', threshold: 5, intervalSeconds: 3600 })).status, 400);
  assert.equal((await call('POST', '/api/alerts', member, { savedSearchId: searchId, webhookId: hookId, thresholdType: 'above', threshold: 5, intervalSeconds: 7 })).status, 400);
  assert.equal((await call('DELETE', `/api/webhooks/${hookId}`, admin)).status, 409, 'a webhook in use cannot be deleted');

  // Point the runner's clock at the end of the loaded data, so the last hour has matches.
  const [{ t }] = await doris.query(`SELECT max(timestamp) AS t FROM ${db}.otel_logs`) as any[];
  const end = Date.parse(`${String(t).replace(' ', 'T')}Z`) + 1000;
  const [{ n }] = await doris.query(`SELECT count(*) AS n FROM ${db}.otel_logs WHERE timestamp >= '${new Date(end - 3600_000).toISOString().replace('T', ' ').replace('Z', '')}' AND service_name = 'payment' AND severity_text IN ('ERROR', 'WARN')`) as any[];
  assert.ok(Number(n) > 5, 'the data has enough payment errors and warnings');
  const runner = new AlertRunner({ store: content, doris, sources: sourcesFor(db), baseUrl: 'https://nereus.example.com', now: () => end });
  const before = received.length;
  assert.equal(await runner.tick(), 1);
  let alert = (await call('GET', `/api/alerts?savedSearchId=${searchId}`)).body.items[0];
  assert.equal(alert.state, 'ALERT');
  assert.equal(alert.lastValue, Number(n));
  assert.equal(received.length, before + 1);
  const msg = received.at(-1);
  assert.equal(msg.state, 'ALERT');
  assert.match(msg.text, /^\[ALERT\] "Payment errors": \d+ matches in the last 1h \(alert when above 5\)$/);
  assert.equal(msg.link, `https://nereus.example.com/search?saved=${searchId}`);
  assert.equal(await runner.tick(), 0, 'not due again within its interval');
  assert.equal((await call('GET', '/api/saved-searches')).body.items[0].alertState, 'ALERT');

  // Raise the threshold and make it due: the next check resolves.
  await content['db'].query('UPDATE alerts SET threshold = 1e9, last_checked_at = NULL');
  await runner.tick();
  alert = (await call('GET', `/api/alerts?savedSearchId=${searchId}`)).body.items[0];
  assert.equal(alert.state, 'OK');
  assert.match(received.at(-1).text, /^\[RESOLVED\]/);
  // Silenced: the state still changes but nothing is sent.
  await call('POST', `/api/alerts/${alert.id}/silence`, member, { minutes: 60 });
  await content['db'].query('UPDATE alerts SET threshold = 5, last_checked_at = NULL');
  const sent = received.length;
  await runner.tick();
  assert.equal((await call('GET', `/api/alerts?savedSearchId=${searchId}`)).body.items[0].state, 'ALERT');
  assert.equal(received.length, sent);
  const history = (await call('GET', `/api/alerts/${alert.id}/history`)).body.items;
  assert.deepEqual(history.map((h: any) => [h.state, h.notified]), [['ALERT', false], ['OK', true], ['ALERT', true]]);
});

test('charts: time series by group, table and number', { skip }, async () => {
  const [{ t }] = await doris.query(`SELECT max(timestamp) AS t FROM ${db}.otel_traces WHERE service_name = 'frontend'`) as any[];
  const to = new Date(Date.parse(`${String(t).replace(' ', 'T')}Z`) + 1000).toISOString();
  const from = new Date(Date.parse(to) - 3 * 3600_000).toISOString();
  const line = await call('POST', '/api/chart', member, { source: 'traces', display: 'line', series: [{ agg: 'count' }, { agg: 'p99', field: 'duration' }], groupBy: 'service', from, to });
  assert.equal(line.status, 200);
  assert.ok(line.body.stepSeconds > 0);
  assert.ok(line.body.rows.length > 0 && 'g' in line.body.rows[0] && 'v1' in line.body.rows[0]);
  const table = await call('POST', '/api/chart', member, { source: 'traces', display: 'table', series: [{ agg: 'count' }], groupBy: 'service', from, to });
  const counts = table.body.rows.map((r: any) => Number(r.v0));
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  const num = await call('POST', '/api/chart', member, { source: 'traces', display: 'number', series: [{ agg: 'count' }, { agg: 'avg', field: 'span_attributes.http.status_code' }], where: 'service:frontend', from, to });
  const [{ n }] = await doris.query(`SELECT count(*) AS n FROM ${db}.otel_traces WHERE service_name = 'frontend' AND timestamp >= '${from.replace('T', ' ').replace('Z', '')}' AND timestamp < '${to.replace('T', ' ').replace('Z', '')}'`) as any[];
  assert.equal(Number(num.body.rows[0].v0), Number(n));
  assert.ok(Number(num.body.rows[0].v1) >= 200);
  const metrics = await call('POST', '/api/chart', member, { source: 'metrics', display: 'line', series: [{ agg: 'avg', field: 'value' }], where: 'metric:process.cpu.utilization', groupBy: 'service', from, to });
  assert.equal(metrics.status, 200);
  assert.ok(metrics.body.rows.length > 0, 'gauge points');
  assert.equal((await call('POST', '/api/chart', member, { source: 'traces', display: 'line', series: [{ agg: 'sum', field: 'span_name' }], from, to })).status, 400);
  assert.equal((await call('POST', '/api/chart', member, { source: 'nope', display: 'line', series: [{ agg: 'count' }], from, to })).status, 400);
});

test('dashboards: tiles are validated and saved; favorites', { skip }, async () => {
  const tile = { title: 'Requests', w: 6, chart: { source: 'traces', display: 'line', series: [{ agg: 'count' }], where: 'is_root:1', groupBy: 'service' } };
  const made = await call('POST', '/api/dashboards', member, { name: 'Checkout', tiles: [tile], tags: ['shop'] });
  assert.equal(made.status, 201);
  assert.equal(made.body.tiles.length, 1);
  assert.match(made.body.tiles[0].id, /^[0-9a-f-]{36}$/);
  const id = made.body.id;
  const upd = await call('PUT', `/api/dashboards/${id}`, member, { ...made.body, tiles: [...made.body.tiles, { ...tile, title: 'Errors', w: 12 }] });
  assert.deepEqual(upd.body.tiles.map((t: any) => [t.title, t.w]), [['Requests', 6], ['Errors', 12]]);
  assert.equal((await call('PUT', `/api/dashboards/${id}`, member, { name: 'x', tiles: [{ ...tile, w: 5 }] })).status, 400);
  assert.equal((await call('PUT', `/api/dashboards/${id}`, member, { name: 'x', tiles: [{ ...tile, chart: { ...tile.chart, series: [{ agg: 'median' }] } }] })).status, 400);
  await call('POST', `/api/dashboards/${id}/favorite`, member, { on: true });
  assert.equal((await call('GET', '/api/dashboards', member)).body.items[0].favorite, true);
  assert.equal((await call('DELETE', `/api/dashboards/${id}`, admin)).status, 200);
  assert.equal((await call('GET', `/api/dashboards/${id}`)).status, 404);
});

test('tile alerts: a grouped p99 fires for the worst group; removing the tile removes them', { skip }, async () => {
  // The end of the generated data (other tests and demo recordings add newer spans of their own).
  const [{ t }] = await doris.query(`SELECT max(timestamp) AS t FROM ${db}.otel_traces WHERE service_name = 'frontend'`) as any[];
  const end = Date.parse(`${String(t).replace(' ', 'T')}Z`) + 1000;
  const lit = (ms: number) => `'${new Date(ms).toISOString().replace('T', ' ').replace('Z', '')}'`;
  const p99s = await doris.query(`SELECT service_name AS s, percentile_approx(duration, 0.99) AS v FROM ${db}.otel_traces
    WHERE timestamp >= ${lit(end - 3600_000)} AND timestamp < ${lit(end)} GROUP BY s ORDER BY v DESC`) as any[];
  assert.ok(p99s.length >= 2);
  const [worst, second] = [p99s[0], p99s[1]];
  const latency = { title: 'p99 by service', w: 6, chart: { source: 'traces', display: 'line', series: [{ agg: 'p99', field: 'duration' }], groupBy: 'service' } };
  const volume = { title: 'Requests', w: 6, chart: { source: 'traces', display: 'number', series: [{ agg: 'count' }], where: 'is_root:1' } };
  const dash = (await call('POST', '/api/dashboards', member, { name: 'Latency', tiles: [latency, volume] })).body;
  const [lt, vt] = dash.tiles;
  const threshold = (Number(worst.v) + Number(second.v)) / 2;
  const a1 = await call('POST', '/api/alerts', member, { dashboardId: dash.id, tileId: lt.id, webhookId: hookId, thresholdType: 'above', threshold, intervalSeconds: 3600 });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.tileTitle, 'p99 by service');
  assert.equal(a1.body.savedSearchId, null);
  const a2 = await call('POST', '/api/alerts', member, { dashboardId: dash.id, tileId: vt.id, webhookId: hookId, thresholdType: 'below', threshold: 1e9, intervalSeconds: 3600 });
  assert.equal(a2.status, 201);
  assert.equal((await call('POST', '/api/alerts', member, { dashboardId: dash.id, tileId: 'nope', webhookId: hookId, thresholdType: 'above', threshold: 1, intervalSeconds: 60 })).status, 400);
  assert.equal((await call('POST', '/api/alerts', member, { dashboardId: dash.id, tileId: lt.id, savedSearchId: searchId, webhookId: hookId, thresholdType: 'above', threshold: 1, intervalSeconds: 60 })).status, 400);

  // Only the two tile alerts are due: the saved-search alert of the earlier test was just checked.
  await content['db'].query('UPDATE alerts SET last_checked_at = now() WHERE dashboard_id IS NULL');
  const runner = new AlertRunner({ store: content, doris, sources: sourcesFor(db), baseUrl: 'https://nereus.example.com', now: () => end });
  const before = received.length;
  assert.equal(await runner.tick(), 2);
  const items = (await call('GET', `/api/alerts?dashboardId=${dash.id}`)).body.items;
  const [x1, x2] = [items.find((a: any) => a.id === a1.body.id), items.find((a: any) => a.id === a2.body.id)];
  assert.equal(x1.state, 'ALERT');
  assert.equal(x1.lastGroup, worst.s, 'the worst service breaches');
  assert.ok(Math.abs(x1.lastValue - Number(worst.v)) / Number(worst.v) < 0.05, `${x1.lastValue} vs ${worst.v}`);
  assert.equal(x2.state, 'ALERT', 'fewer requests than a billion');
  const msgs = received.slice(before);
  assert.equal(msgs.length, 2);
  const m1 = msgs.find((m: any) => m.tile.id === lt.id);
  assert.match(m1.text, new RegExp(`^\\[ALERT\\] "Latency / p99 by service": p99\\(duration\\) = [\\d.]+ for ${worst.s} in the last 1h \\(alert when above `));
  assert.equal(m1.link, `https://nereus.example.com/dashboards/${dash.id}`);
  assert.equal(m1.tile.group, worst.s);
  assert.equal((await call('GET', `/api/alerts/${a1.body.id}/history`)).body.items[0].group, worst.s);

  // A tile that disappears behind the alert's back (not through the API) is an error, not a crash.
  await content['db'].query(`UPDATE dashboards SET tiles = '[]' WHERE id = $1`, [dash.id]);
  await content['db'].query('UPDATE alerts SET last_checked_at = NULL WHERE dashboard_id = $1', [dash.id]);
  await runner.tick();
  assert.match((await call('GET', `/api/alerts/${a2.body.id}/history`)).body.items[0].error, /tile was removed/);
  // Saving the dashboard without a tile deletes that tile's alerts.
  await call('PUT', `/api/dashboards/${dash.id}`, member, { ...dash, tiles: [lt] });
  const left = (await call('GET', `/api/alerts?dashboardId=${dash.id}`)).body.items;
  assert.deepEqual(left.map((a: any) => a.id), [a1.body.id]);
  // Deleting the dashboard deletes the rest.
  await call('DELETE', `/api/dashboards/${dash.id}`, admin);
  assert.equal((await call('GET', `/api/alerts?dashboardId=${dash.id}`)).body.items.length, 0);
});
