// End-to-end API checks against a live Doris loaded by bench/otelgen.py. Skipped unless DORIS_TEST=1.
//   DORIS_TEST=1 DORIS_PORT=9930 DORIS_DB=otel_bench node --test test/api.doris.test.ts

import { IngestKeys } from '../src/sessions/http.ts';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Doris, configFromEnv } from '../src/db.ts';
import { ContentStore } from '../src/content/store.ts';
import { AuthStore } from '../src/auth/store.ts';
import { createApp } from '../src/server.ts';
import { freshMetaDb } from './meta-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = process.env.DORIS_DB ?? 'otel_bench';
let base = '';
let apiKey = '';
let doris: Doris;
let close: () => Promise<void> = async () => {};

// Wide enough for any data otelgen wrote in the last week.
const to = new Date(Date.now() + 3600_000).toISOString();
const from = new Date(Date.now() - 7 * 86400_000).toISOString();

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  const meta = await freshMetaDb();
  const store = new AuthStore(meta.pool);
  const admin = await store.setup('admin@example.com', 'Admin', 'adminpass1');
  apiKey = (await store.createApiKey(admin.id, 'tests')).key;
  const server = createApp({ doris, db, auth: { store, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await doris.close();
    await meta.drop();
  };
});
after(() => close());

async function get(path: string, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: await res.json() };
}

test('search returns newest matching rows first', { skip: !enabled }, async () => {
  const { status, body } = await get('/api/search', { source: 'logs', q: 'level:ERROR', from, to, limit: '20' });
  assert.equal(status, 200);
  assert.equal(body.rows.length, 20);
  for (const r of body.rows) assert.equal(r.severity_text, 'ERROR');
  const ts = body.rows.map((r: any) => r.timestamp);
  assert.deepEqual(ts, [...ts].sort().reverse());
});

test('histogram counts add up to the search count', { skip: !enabled }, async () => {
  const q = 'service:checkout level:(DEBUG OR ERROR)';
  const h = await get('/api/histogram', { source: 'logs', q, from, to, groupBy: 'severity_text' });
  assert.equal(h.status, 200);
  const total = h.body.buckets.reduce((s: number, b: any) => s + Number(b.n), 0);
  const all = await get('/api/search', { source: 'logs', q, from, to, limit: '10000', columns: 'timestamp' });
  assert.ok(total > 0 && total < 10000, `total ${total} must fit one search page`);
  assert.equal(total, all.body.rows.length);
  assert.ok(h.body.buckets.every((b: any) => b.g === 'DEBUG' || b.g === 'ERROR'));
});

test('a log line links to its trace, and the trace contains its span', { skip: !enabled }, async () => {
  const log = (await get('/api/search', { source: 'logs', q: 'level:ERROR', from, to, limit: '1' })).body.rows[0];
  const { status, body } = await get(`/api/trace/${log.trace_id}`, { from, to });
  assert.equal(status, 200);
  assert.ok(body.spans.length >= 1);
  assert.ok(body.spans.some((s: any) => s.span_id === log.span_id));
  const roots = body.spans.filter((s: any) => String(s.is_root) === '1');
  assert.equal(roots.length, 1);
  for (const s of body.spans) {
    if (String(s.is_root) !== '1') assert.ok(body.spans.some((p: any) => p.span_id === s.parent_span_id));
  }
});

test('bad queries answer 400 with a message', { skip: !enabled }, async () => {
  for (const params of [
    { source: 'logs', q: '"unterminated', from, to },
    { source: 'logs', q: 'severity_number:abc', from, to },
    { source: 'nope', q: '', from, to },
    { source: 'logs', q: '', from: 'yesterday', to },
  ]) {
    const { status, body } = await get('/api/search', params);
    assert.equal(status, 400, JSON.stringify(params));
    assert.equal(typeof body.error, 'string');
  }
  assert.equal((await get('/api/trace/not-a-trace', { from, to })).status, 400);
});

test('fields list columns, aliases and attribute paths with types', { skip: !enabled }, async () => {
  const { status, body } = await get('/api/fields', { source: 'logs' });
  assert.equal(status, 200);
  const byName = new Map(body.fields.map((f: any) => [f.name, f.type]));
  assert.equal(byName.get('body'), 'text');
  assert.ok(byName.has('level'), 'alias listed');
  assert.equal(byName.get('k8s.pod.name'), 'text', 'resource attribute path without its column prefix');
  assert.equal(byName.get('thread.id'), 'bigint');
  assert.ok(!byName.has('resource_attributes'), 'VARIANT roots are not searchable fields');
});

test('top values of a field honour the query', { skip: !enabled }, async () => {
  const { status, body } = await get('/api/values', { source: 'logs', field: 'k8s.pod.name', q: 'service:payment', from, to });
  assert.equal(status, 200);
  assert.ok(body.values.length > 0 && body.values.length <= 10);
  for (const v of body.values) assert.match(v.v, /^payment-\d$/);
  const counts = body.values.map((v: any) => Number(v.n));
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('search warns about fields the data does not have', { skip: !enabled }, async () => {
  const typo = await get('/api/search', { source: 'logs', q: 'levl:ERROR', from, to, limit: '5' });
  assert.equal(typo.status, 200);
  assert.deepEqual(typo.body.warnings, [{ kind: 'unknown_field', field: 'levl', suggestion: 'level' }]);
  const fine = await get('/api/search', { source: 'logs', q: 'level:error k8s.pod.name:cart-1', from, to, limit: '5' });
  assert.deepEqual(fine.body.warnings, []);
  assert.ok(fine.body.rows.length > 0, 'lower-case level matches');
});

test('SQL WHERE, filters, SELECT, ORDER BY and paging', { skip: !enabled }, async () => {
  const count = async (params: Record<string, string>) => (await get('/api/histogram', { source: 'logs', from, to, buckets: '1', ...params }))
    .body.buckets.reduce((s: number, b: any) => s + Number(b.n), 0);
  const lucene = await count({ where: 'level:error service:payment' });
  assert.ok(lucene > 0);
  assert.equal(await count({ where: "severity_text = 'ERROR' AND service_name = 'payment'", language: 'sql' }), lucene);
  assert.equal(await count({ where: 'level:error', filters: JSON.stringify([{ field: 'service', values: ['payment'] }]) }), lucene);
  const all = await count({ where: 'level:error' });
  assert.equal(await count({ where: 'level:error', filters: JSON.stringify([{ field: 'service', values: ['payment'], exclude: true }]) }),
    all - lucene);
  assert.equal((await get('/api/search', { source: 'logs', where: '1=1; DROP TABLE x', language: 'sql', from, to })).status, 400);

  const page1 = await get('/api/search', { source: 'traces', where: 'is_root:1', select: 'timestamp, service, duration / 1000', orderBy: 'duration DESC', limit: '5', from, to });
  assert.equal(page1.status, 200);
  assert.deepEqual(page1.body.columns.map((c: any) => c.label), ['timestamp', 'service', 'duration / 1000']);
  const d = page1.body.rows.map((r: any) => Number(r.duration));
  assert.deepEqual(d, [...d].sort((a, b) => b - a));
  assert.equal(Number(page1.body.rows[0].__e2), d[0]! / 1000);
  assert.ok(page1.body.rows[0].span_id, 'rows carry every column for the side panel');
  assert.match(page1.body.sql, /ORDER BY duration DESC LIMIT 5$/);
  const page2 = await get('/api/search', { source: 'traces', where: 'is_root:1', orderBy: 'duration DESC', limit: '5', offset: '5', from, to });
  assert.ok(Number(page2.body.rows[0].duration) <= d.at(-1)!);
});

test('facets list top values with counts from a sample, honouring the query', { skip: !enabled }, async () => {
  const { status, body } = await get('/api/facets', { source: 'logs', where: 'level:error', from, to });
  assert.equal(status, 200);
  const svc = body.facets.find((f: any) => f.field === 'service_name');
  assert.ok(svc && svc.values.length > 0);
  assert.ok(body.facets.some((f: any) => f.field === 'k8s.pod.name'), 'attribute paths are facets');
  assert.ok(!body.facets.some((f: any) => ['body', 'trace_id', 'timestamp'].includes(f.field)));
  const lvl = body.facets.find((f: any) => f.field === 'severity_text');
  assert.deepEqual(lvl.values.map((v: any) => v.v), ['ERROR']);
  assert.ok(svc.values.reduce((s: number, v: any) => s + v.n, 0) <= body.sampled);
});

test('service map: calls between services match a reference join; nodes count entry spans', { skip: !enabled }, async () => {
  const { status, body } = await get('/api/service-map', { from, to });
  assert.equal(status, 200);
  const edge = (s: string, d: string) => body.edges.find((e: any) => e.src === s && e.dst === d);
  assert.ok(edge('frontend', 'checkout'), 'frontend calls checkout');
  assert.ok(edge('checkout', 'payment'), 'checkout calls payment');
  assert.ok(!body.edges.some((e: any) => e.src === e.dst), 'no self edges');
  assert.ok(!body.edges.some((e: any) => e.dst === 'frontend'), 'nobody calls frontend');
  const sql = (q: string) => execFileSync('mysql', ['-h', process.env.DORIS_HOST ?? '127.0.0.1', '-P', process.env.DORIS_PORT ?? '9030', '-uroot', '-N', '-B', '-e', q], { encoding: 'utf8' }).trim();
  const ref = sql(`SELECT count(*) FROM ${db}.otel_traces c JOIN ${db}.otel_traces p ON c.trace_id = p.trace_id AND c.parent_span_id = p.span_id ` +
    `WHERE c.service_name = 'checkout' AND p.service_name = 'frontend'`);
  assert.equal(Number(edge('frontend', 'checkout').calls), Number(ref));
  const fe = body.nodes.find((n: any) => n.service === 'frontend');
  assert.equal(Number(fe.requests), Number(sql(`SELECT count(*) FROM ${db}.otel_traces WHERE service_name = 'frontend' AND (is_root = 1 OR span_kind = 'SPAN_KIND_SERVER')`)));
  const filtered = await get('/api/service-map', { from, to, where: 'status:error' });
  assert.ok(filtered.body.edges.every((e: any) => Number(e.errors) === Number(e.calls)), 'the query filters the calls');
});

test('heatmap: counts per time bucket and duration band add up to the span count', { skip: !enabled }, async () => {
  const { status, body } = await get('/api/heatmap', { from, to, where: 'service:frontend' });
  assert.equal(status, 200);
  const total = body.cells.reduce((s: number, c: any) => s + Number(c.n), 0);
  const all = await get('/api/histogram', { source: 'traces', where: 'service:frontend', from, to, buckets: '1' });
  assert.equal(total, all.body.buckets.reduce((s: number, b: any) => s + Number(b.n), 0));
  assert.ok(body.cells.every((c: any) => Number.isInteger(Number(c.b)) && Number(c.b) >= 0));
});

test('histogram group by: top groups keep their series, the rest add up under (other)', { skip: !enabled }, async () => {
  const all = await get('/api/histogram', { source: 'traces', from, to, buckets: '4', groupBy: 'span_name' });
  const top = await get('/api/histogram', { source: 'traces', from, to, buckets: '4', groupBy: 'span_name', groups: '3' });
  assert.equal(top.status, 200, JSON.stringify(top.body));
  const sum = (b: any[]) => b.reduce((s, x) => s + Number(x.n), 0);
  assert.equal(sum(top.body.buckets), sum(all.body.buckets), 'nothing is lost');
  const names = new Set(top.body.buckets.map((b: any) => b.g));
  assert.ok(names.has('(other)'));
  assert.ok(names.size <= 4, [...names].join(', '));
  const totals = new Map<string, number>();
  for (const b of all.body.buckets) totals.set(b.g, (totals.get(b.g) ?? 0) + Number(b.n));
  const best = [...totals].sort((a, b) => b[1] - a[1])[0]![0];
  assert.ok(names.has(best), `the most frequent span name ${best} has its own series`);
});

test('4-byte UTF-8 in a query survives the connection', { skip: !enabled }, async () => {
  const d = new Doris(configFromEnv());
  try {
    const [row] = await d.query("SELECT '😀 ok' AS v") as any[];
    assert.equal(row.v, '😀 ok');
  } finally {
    await d.close();
  }
});
