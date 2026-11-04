// End-to-end API checks against a live Doris loaded by bench/otelgen.py. Skipped unless DORIS_TEST=1.
//   DORIS_TEST=1 DORIS_PORT=9730 DORIS_DB=otel_bench node --test test/api.doris.test.ts

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Doris, configFromEnv } from '../src/db.ts';
import { createApp } from '../src/server.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = process.env.DORIS_DB ?? 'otel_bench';
let base = '';
let doris: Doris;
let close: () => Promise<void> = async () => {};

// Wide enough for any data otelgen wrote in the last week.
const to = new Date(Date.now() + 3600_000).toISOString();
const from = new Date(Date.now() - 7 * 86400_000).toISOString();

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  const server = createApp({ doris, db });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await doris.close();
  };
});
after(() => close());

async function get(path: string, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`);
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
