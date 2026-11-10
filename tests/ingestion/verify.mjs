import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Doris, configFromEnv } from '../../server/src/db.ts';
import { sqlString } from '../../server/src/query/compile.ts';

const artifacts = process.env.ARTIFACT_DIR;
assert.ok(artifacts, 'ARTIFACT_DIR must contain the client manifests');
const db = process.env.DORIS_DB ?? 'otel_test';
assert.match(db, /^[a-zA-Z_][a-zA-Z0-9_]*$/, 'DORIS_DB must be an SQL identifier');
const base = process.env.NEREUS_URL ?? 'http://nereus:8090';
const doris = new Doris(configFromEnv());
const read = (name) => JSON.parse(readFileSync(join(artifacts, `${name}.json`), 'utf8'));
const protocols = ['http', 'grpc', ...(process.env.INCLUDE_JAEGER === '1' ? ['jaeger'] : [])].map(read);
const fidelity = ['fidelity-http', 'fidelity-grpc'].map(read);
const range = new URLSearchParams({ from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 300_000).toISOString() });
const result = { protocols: [], fidelity: [], api: null };
const parse = (v) => typeof v === 'string' ? JSON.parse(v) : v;
const field = (v, path) => {
  const obj = parse(v);
  return obj[path] ?? path.split('.').reduce((node, key) => node?.[key], obj);
};
let cookie;

async function api(path, options = {}, status = 200) {
  const response = await fetch(`${base}${path}`, {
    ...options, signal: AbortSignal.timeout(15_000),
    headers: { cookie, 'content-type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForRows(table, where, expected) {
  const deadline = Date.now() + 90_000;
  let rows = [];
  do {
    rows = await doris.query(`SELECT * FROM ${db}.${table} WHERE ${where}`);
    if (rows.length === expected) return rows;
    if (rows.length > expected) break;
    await delay(500);
  } while (Date.now() < deadline);
  assert.equal(rows.length, expected, `${table}: all exported rows must become visible`);
  return rows;
}

before(async () => {
  const status = await (await fetch(`${base}/api/auth/status`, { signal: AbortSignal.timeout(15_000) })).json();
  assert.equal(status.setupRequired, true, 'Run against the fresh Compose test environment');
  const response = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ email: 'ingestion@example.test', name: 'Integration test', password: randomBytes(24).toString('base64url') }),
  });
  assert.equal(response.status, 201, 'The test environment must create its own administrator');
  cookie = response.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  try {
    writeFileSync(join(artifacts, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await doris.close();
  }
});

for (const manifest of protocols) {
  const coverage = manifest.transport === 'jaeger-udp'
    ? 'native spans preserve trace propagation and attributes'
    : 'real client preserves trace propagation, logs, metrics and exemplars';
  test(`${manifest.transport}: ${coverage}`, async () => {
    const services = [manifest.frontend, manifest.backend].map(sqlString).join(', ');
    const spans = await waitForRows('otel_traces', `service_name IN (${services})`, manifest.expected.spans);
    const logs = await waitForRows('otel_logs', `service_name IN (${services})`, manifest.expected.logs);
    for (const row of [...spans, ...logs]) assert.equal(field(row.resource_attributes, 'test.run_id'), manifest.run_id);
    for (const trace of manifest.traces) {
      const rows = spans.filter((s) => s.trace_id === trace.trace_id);
      assert.equal(rows.length, 2, 'Each request must preserve both client and server spans');
      const parent = rows.find((s) => s.span_id === trace.root_span_id);
      const child = rows.find((s) => s.span_id === trace.server_span_id);
      assert.ok(parent && child, 'Original span IDs must be retained');
      assert.equal(parent.parent_span_id, '');
      assert.equal(child.parent_span_id, parent.span_id);
      assert.equal(parent.service_name, manifest.frontend);
      assert.equal(child.service_name, manifest.backend);
      assert.equal(Number(parent.is_root), 1);
      assert.equal(Number(child.is_root), 0);
      assert.equal(parent.span_kind, 'SPAN_KIND_CLIENT');
      assert.equal(child.span_kind, 'SPAN_KIND_SERVER');
      if (manifest.transport !== 'jaeger-udp') {
        assert.match(trace.propagation, new RegExp(`^00-${trace.trace_id}-${parent.span_id}-01$`));
      } else {
        assert.equal(trace.propagation.split(':')[0].padStart(32, '0'), trace.trace_id, 'Jaeger context must retain the trace ID');
      }
      for (const row of rows) {
        assert.equal(row.status_code, 'STATUS_CODE_ERROR');
        assert.ok(Number(row.duration) > 0, 'Span durations must be positive microseconds');
        assert.equal(field(row.span_attributes, 'http.status_code'), 503);
        assert.equal(field(row.span_attributes, 'order.index'), trace.order);
        assert.equal(field(row.span_attributes, 'checkout.failed'), 1);
      }
      assert.ok(JSON.stringify(parse(child.events)).includes('Payment processor unavailable'));
      if (manifest.transport !== 'jaeger-udp') {
        const linked = logs.filter((l) => l.trace_id === trace.trace_id);
        assert.equal(linked.length, 2);
        assert.deepEqual(linked.map((l) => l.span_id).sort(), [parent.span_id, child.span_id].sort());
        for (const log of linked) {
          assert.equal(log.severity_text, 'ERROR');
          assert.ok(log.body.includes(`order ${trace.order}`));
        }
      }
    }
    if (manifest.transport !== 'jaeger-udp') {
      const metrics = {};
      for (const kind of ['gauge', 'sum', 'histogram']) {
        [metrics[kind]] = await waitForRows(`otel_metrics_${kind}`, `service_name = ${sqlString(manifest.backend)}`, 1);
        assert.equal(field(metrics[kind].resource_attributes, 'test.run_id'), manifest.run_id);
      }
      assert.equal(Number(metrics.gauge.value), manifest.expected.gauge);
      assert.equal(Number(metrics.sum.value), manifest.expected.counter);
      assert.equal(Number(metrics.histogram.count), manifest.expected.histogram_count);
      assert.equal(Number(metrics.histogram.sum), manifest.expected.histogram_sum);
      assert.equal(Number(metrics.histogram.min), manifest.expected.histogram_min);
      assert.equal(Number(metrics.histogram.max), manifest.expected.histogram_max);
      assert.equal(parse(metrics.histogram.bucket_counts).reduce((sum, n) => sum + Number(n), 0), manifest.expected.histogram_count);
      assert.equal(field(metrics.sum.attributes, 'outcome'), 'error');
      for (const metric of [metrics.sum, metrics.histogram]) {
        const exemplars = parse(metric.exemplars);
        assert.ok(exemplars.length > 0, 'Sampled requests must produce metric exemplars');
        for (const exemplar of exemplars) {
          const trace = manifest.traces.find((t) => t.trace_id === exemplar.trace_id);
          assert.ok(trace, 'Each exemplar must link to an exported trace');
          assert.equal(exemplar.span_id, trace.server_span_id);
          assert.deepEqual(exemplar.filtered_attributes, manifest.exemplar_attributes);
        }
      }
    }
    result.protocols.push({ transport: manifest.transport, status: 'PASS', spans: spans.length, logs: logs.length });
  });
}

for (const manifest of fidelity) {
  test(`${manifest.transport}: SDK protobuf, event/link strings and exception stack traces round-trip`, async () => {
    const [span] = await waitForRows('otel_traces', `trace_id = ${sqlString(manifest.trace_id)}`, 1);
    const [log] = await waitForRows('otel_logs', `trace_id = ${sqlString(manifest.trace_id)}`, 1);
    const events = parse(span.events), links = parse(span.links);
    const sdk = manifest.wire.resourceSpans[0].scopeSpans[0].spans[0];
    const attributes = (entries) => Object.fromEntries(entries.filter((e) => 'stringValue' in e.value).map((e) => [e.key, e.value.stringValue]));
    const event = events.find((e) => e.name === manifest.event_name);
    const wireEvent = sdk.events.find((e) => e.name === manifest.event_name);
    assert.ok(event && wireEvent, 'Escaped event names must be retained');
    assert.deepEqual(attributes(wireEvent.attributes), manifest.attributes);
    assert.deepEqual(event.attributes, manifest.attributes);
    const exception = events.find((e) => e.name === 'exception');
    const wireException = sdk.events.find((e) => e.name === 'exception');
    assert.ok(exception && wireException, 'The recorded exception must be retained');
    const expectedException = attributes(wireException.attributes);
    for (const [key, value] of Object.entries(expectedException)) assert.equal(exception.attributes[key], value, key);
    assert.ok(exception.attributes['exception.stacktrace'].includes('\n'));
    assert.equal(links.length, 1);
    assert.equal(links[0].trace_id, manifest.link_trace_id);
    assert.equal(links[0].span_id, manifest.link_span_id);
    assert.deepEqual(links[0].attributes, attributes(sdk.links[0].attributes));
    assert.deepEqual(links[0].attributes, manifest.attributes);
    for (const [key, value] of Object.entries(manifest.attributes)) {
      if (key !== 'probe.nul') assert.equal(field(span.span_attributes, key), value, key);
    }
    assert.equal(log.body, manifest.log_body);
    assert.equal(log.trace_id, span.trace_id);
    assert.equal(log.span_id, span.span_id);
    const detail = await api(`/api/trace/${manifest.trace_id}?${range}`);
    assert.equal(detail.spans.length, 1);
    assert.deepEqual(parse(detail.spans[0].events), events);
    assert.deepEqual(parse(detail.spans[0].links), links);
    const params = new URLSearchParams({ ...Object.fromEntries(range), source: 'logs', where: `trace_id:${manifest.trace_id}` });
    const search = await api(`/api/search?${params}`);
    assert.equal(search.rows.length, 1);
    assert.equal(search.rows[0].body, manifest.log_body);
    result.fidelity.push({ transport: manifest.transport, status: 'PASS' });
  });
}

test('production API searches imported data, correlates traces and logs, and builds service edges', async () => {
  for (const manifest of protocols) {
    const trace = manifest.traces[0];
    const detail = await api(`/api/trace/${trace.trace_id}?${range}`);
    assert.equal(detail.spans.length, 2);
    const params = new URLSearchParams({ ...Object.fromEntries(range), source: 'traces', where: `trace_id:${trace.trace_id}` });
    assert.equal((await api(`/api/search?${params}`)).rows.length, 2);
    if (manifest.transport !== 'jaeger-udp') {
      params.set('source', 'logs');
      assert.equal((await api(`/api/search?${params}`)).rows.length, 2);
    }
  }
  const map = await api(`/api/service-map?${range}`);
  for (const manifest of protocols) {
    const edge = map.edges.find((e) => e.src === manifest.frontend && e.dst === manifest.backend);
    assert.ok(edge, `${manifest.transport}: imported service edge must exist`);
    assert.equal(Number(edge.calls), manifest.traces.length);
    assert.equal(Number(edge.errors), manifest.traces.length);
  }
  const chart = await api('/api/chart', { method: 'POST', body: JSON.stringify({
    source: 'metrics', display: 'number', series: [{ agg: 'count' }, { agg: 'max', field: 'value' }],
    from: range.get('from'), to: range.get('to'),
  }) });
  assert.equal(Number(chart.rows[0].v0), 2);
  assert.equal(Number(chart.rows[0].v1), 7);
  result.api = 'PASS';
});
