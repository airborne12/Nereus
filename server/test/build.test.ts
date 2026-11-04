import assert from 'node:assert/strict';
import { test } from 'node:test';
import { histogramSql, histogramStep, parseTime, rowsSql, traceSql } from '../src/query/build.ts';
import { CompileError } from '../src/query/compile.ts';
import { logsSource, tracesSource } from '../src/query/source.ts';

const logs = logsSource();
const range = { from: '2026-11-04T04:00:00Z', to: '2026-11-04 05:00:00' };

test('rows: time bounds, compiled filter, newest first', () => {
  assert.equal(
    rowsSql(logs, { ...range, query: 'level:ERROR', limit: 50, columns: ['timestamp', 'body'] }),
    "SELECT timestamp, body FROM otel.otel_logs WHERE timestamp >= '2026-11-04 04:00:00.000' " +
      "AND timestamp < '2026-11-04 05:00:00.000' AND search('severity_text:ERROR') " +
      'ORDER BY timestamp DESC LIMIT 50',
  );
});

test('rows: rejects bad limits, unknown columns and empty ranges', () => {
  assert.throws(() => rowsSql(logs, { ...range, query: '', limit: 0 }), CompileError);
  assert.throws(() => rowsSql(logs, { ...range, query: '', limit: 10_001 }), CompileError);
  assert.throws(() => rowsSql(logs, { ...range, query: '', columns: ['body; DROP'] }), CompileError);
  assert.throws(() => rowsSql(logs, { from: range.to, to: range.from, query: '' }), CompileError);
  assert.throws(() => parseTime('yesterday'), CompileError);
});

test('histogram step keeps the bucket count under the limit', () => {
  const h = 3600_000;
  assert.equal(histogramStep(0, h, 120)[0], 30); // 120 buckets of 30 s
  assert.equal(histogramStep(0, 24 * h, 120)[0], 1800); // 48 buckets of 30 min
  assert.equal(histogramStep(0, 60_000, 120)[0], 1);
});

test('histogram groups by a string column only', () => {
  const { sql, stepSeconds } = histogramSql(logs, { ...range, query: '', groupBy: 'severity_text' });
  assert.equal(stepSeconds, 30);
  assert.match(sql, /^SELECT second_floor\(timestamp, 30\) AS t, severity_text AS g, count\(\*\) AS n FROM/);
  assert.match(sql, /GROUP BY t, g ORDER BY t, g$/);
  assert.throws(() => histogramSql(logs, { ...range, query: '', groupBy: 'severity_number' }), CompileError);
});

test('trace lookup validates the id', () => {
  const t = tracesSource();
  assert.match(traceSql(t, '0123456789abcdef0123456789abcdef', range), /trace_id = '0123456789abcdef0123456789abcdef'/);
  assert.throws(() => traceSql(t, "x' OR '1'='1", range), CompileError);
});

test('values: field expression, filter, frequency order', async () => {
  const { valuesSql, fieldsFromDescribe } = await import('../src/query/build.ts');
  assert.equal(
    valuesSql(logs, { ...range, field: 'level', query: 'service:cart' }),
    "SELECT severity_text AS v, count(*) AS n FROM otel.otel_logs WHERE timestamp >= '2026-11-04 04:00:00.000' " +
      "AND timestamp < '2026-11-04 05:00:00.000' AND search('service_name:cart') AND severity_text IS NOT NULL " +
      'GROUP BY v ORDER BY n DESC LIMIT 10',
  );
  assert.match(valuesSql(logs, { ...range, field: 'k8s.pod.name', query: '' }),
    /^SELECT coalesce\(CAST\(log_attributes\['k8s.pod.name'\] AS STRING\), CAST\(resource_attributes\['k8s.pod.name'\] AS STRING\)\) AS v/);
  const fields = fieldsFromDescribe(logs, [
    { Field: 'body', Type: 'text' }, { Field: 'severity_text', Type: 'varchar(32)' },
    { Field: 'resource_attributes', Type: 'variant<...>' },
    { Field: 'resource_attributes.k8s.pod.name', Type: 'text' }, { Field: 'log_attributes.thread.id', Type: 'bigint' },
  ]);
  assert.deepEqual(fields.map((f) => f.name), ['body', 'k8s.pod.name', 'level', 'message', 'msg', 'severity', 'severity_text', 'thread.id']);
});
