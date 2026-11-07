import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultFacetFields, facetsSql, fieldsFromDescribe, histogramStep, parseTime, searchHistogramSql, searchRowsSql,
  searchWhere, selectColumns, splitSelect, traceSql, valuesSql,
} from '../src/query/build.ts';
import { CompileError } from '../src/query/compile.ts';
import { logsSource, tracesSource } from '../src/query/source.ts';

const logs = logsSource();
const traces = tracesSource();
const range = { from: '2026-11-04T04:00:00Z', to: '2026-11-04 05:00:00' };
const TIME = "timestamp >= '2026-11-04 04:00:00.000' AND timestamp < '2026-11-04 05:00:00.000'";
const LEVEL = "search('(severity_text:ERROR OR severity_text:error OR severity_text:Error)')";

test('where: time bounds, Lucene or SQL, and filters kept apart from the text', () => {
  assert.equal(searchWhere(logs, { ...range, where: '' }), TIME);
  assert.equal(searchWhere(logs, { ...range, where: 'level:error' }), `${TIME} AND ${LEVEL}`);
  assert.equal(searchWhere(logs, { ...range, where: "severity_number >= 17 OR body LIKE '%x%'", language: 'sql' }),
    `${TIME} AND (severity_number >= 17 OR body LIKE '%x%')`);
  assert.equal(searchWhere(logs, { ...range, where: '', filters: [
    { field: 'service', values: ['cart', "o'k"] },
    { field: 'k8s.pod.name', values: ['cart-1'], exclude: true },
  ] }), `${TIME} AND service_name IN ('cart', 'o\\'k') AND NOT coalesce(coalesce(CAST(log_attributes['k8s.pod.name'] AS STRING), ` +
    "CAST(resource_attributes['k8s.pod.name'] AS STRING)) IN ('cart-1'), false)");
  assert.throws(() => searchWhere(logs, { ...range, where: '1=1; DROP TABLE x', language: 'sql' }), /one expression only/);
  assert.throws(() => searchWhere(logs, { ...range, where: '', filters: [{ field: 'service', values: [] }] }), CompileError);
});

test('SELECT lists split on top-level commas and map to row keys', () => {
  assert.deepEqual(splitSelect("timestamp, concat(a, ','), round(duration / 1000, 1),k8s.pod.name"),
    ['timestamp', "concat(a, ',')", 'round(duration / 1000, 1)', 'k8s.pod.name']);
  const { extra, columns } = selectColumns(logs, 'timestamp, level, k8s.pod.name, upper(body)');
  assert.deepEqual(columns, [
    { label: 'timestamp', key: 'timestamp' }, { label: 'level', key: '__e1' },
    { label: 'k8s.pod.name', key: '__e2' }, { label: 'upper(body)', key: '__e3' },
  ]);
  assert.deepEqual(extra, ['severity_text AS __e1',
    "coalesce(CAST(log_attributes['k8s.pod.name'] AS STRING), CAST(resource_attributes['k8s.pod.name'] AS STRING)) AS __e2",
    'upper(body) AS __e3']);
});

test('rows: every column plus SELECT extras, ORDER BY, paging', () => {
  const { sql, columns } = searchRowsSql(logs, { ...range, where: 'level:error', limit: 50, offset: 100 });
  assert.equal(sql, `SELECT * FROM otel.otel_logs WHERE ${TIME} AND ${LEVEL} ORDER BY timestamp DESC LIMIT 50 OFFSET 100`);
  assert.deepEqual(columns.map((c) => c.label), ['timestamp', 'service_name', 'severity_text', 'body']);
  const t = searchRowsSql(traces, { ...range, where: '', orderBy: 'duration DESC' });
  assert.match(t.sql, /^SELECT \*, round\(duration \/ 1000, 1\) AS __e3 FROM otel\.otel_traces .* ORDER BY duration DESC LIMIT 200$/);
  assert.throws(() => searchRowsSql(logs, { ...range, where: '', limit: 0 }), CompileError);
  assert.throws(() => searchRowsSql(logs, { ...range, where: '', orderBy: 'timestamp; x' }), CompileError);
  assert.throws(() => searchRowsSql(logs, { ...range, where: '', offset: -1 }), CompileError);
  assert.throws(() => searchRowsSql(logs, { from: range.to, to: range.from, where: '' }), CompileError);
  assert.throws(() => parseTime('yesterday'), CompileError);
});

test('histogram step keeps the bucket count under the limit; groups by any field', () => {
  const h = 3600_000;
  assert.equal(histogramStep(0, h, 120)[0], 30);
  assert.equal(histogramStep(0, 24 * h, 120)[0], 1800);
  assert.equal(histogramStep(0, 60_000, 120)[0], 1);
  const { sql, stepSeconds } = searchHistogramSql(logs, { ...range, where: '', groupBy: 'level' });
  assert.equal(stepSeconds, 30);
  assert.equal(sql, `SELECT second_floor(timestamp, 30) AS t, severity_text AS g, count(*) AS n FROM otel.otel_logs WHERE ${TIME} ` +
    'GROUP BY t, g ORDER BY t, g');
});

test('facets: top values of many fields from one sample', () => {
  assert.equal(facetsSql(logs, { ...range, where: '' }, ['service_name', 'k8s.pod.name']),
    'SELECT count(*) AS __sampled, topn(f0, 10) AS f0, topn(f1, 10) AS f1 FROM (SELECT service_name AS f0, ' +
    "coalesce(CAST(log_attributes['k8s.pod.name'] AS STRING), CAST(resource_attributes['k8s.pod.name'] AS STRING)) AS f1 " +
    `FROM otel.otel_logs WHERE ${TIME} ORDER BY timestamp DESC LIMIT 20000) s`);
  assert.deepEqual(defaultFacetFields(logs, [
    { name: 'body', type: 'text' }, { name: 'trace_id', type: 'varchar(64)' }, { name: 'service_name', type: 'varchar(256)' },
    { name: 'level', type: 'varchar(32)' }, { name: 'k8s.pod.name', type: 'text' }, { name: 'thread.id', type: 'bigint' },
    { name: 'code.function', type: 'text' }, { name: 'severity_text', type: 'varchar(32)' },
    { name: 'service_instance_id', type: 'varchar(256)' },
  ]), ['service_name', 'severity_text', 'service_instance_id', 'code.function', 'k8s.pod.name']);
});

test('trace lookup validates the id', () => {
  assert.match(traceSql(traces, '0123456789abcdef0123456789abcdef', range), /trace_id = '0123456789abcdef0123456789abcdef'/);
  assert.throws(() => traceSql(traces, "x' OR '1'='1", range), CompileError);
});

test('values and fields', () => {
  assert.equal(valuesSql(logs, { ...range, field: 'level', query: 'service:cart' }),
    `SELECT severity_text AS v, count(*) AS n FROM otel.otel_logs WHERE ${TIME} AND search('service_name:cart') ` +
    'AND severity_text IS NOT NULL GROUP BY v ORDER BY n DESC LIMIT 10');
  const fields = fieldsFromDescribe(logs, [
    { Field: 'body', Type: 'text' }, { Field: 'severity_text', Type: 'varchar(32)' },
    { Field: 'resource_attributes', Type: 'variant<...>' },
    { Field: 'resource_attributes.k8s.pod.name', Type: 'text' }, { Field: 'log_attributes.thread.id', Type: 'bigint' },
  ]);
  assert.deepEqual(fields.map((f) => f.name), ['body', 'k8s.pod.name', 'level', 'message', 'msg', 'severity', 'severity_text', 'thread.id']);
});

test('SQL fragments: expressions pass; subqueries, table functions, exports, comments and escapes are refused', async () => {
  const { sqlFragment } = await import('../src/query/build.ts');
  for (const ok of [
    "severity_text = 'ERROR' AND body LIKE '%select from union%'",
    'duration > 1000 AND lower(service_name) IN (\'cart\', "payment")',
    "log_attributes['k8s.pod.name'] = 'it''s'",
    'round(duration / 1000, 1)',
    'duration DESC, timestamp ASC',
    "CASE WHEN status_code = 'STATUS_CODE_ERROR' THEN 1 ELSE 0 END",
    'cast(span_attributes[\'http.status_code\'] AS INT) >= 500',
    'date_trunc(timestamp, \'hour\')',
    '`service_name` = \'x\'',
  ]) assert.equal(sqlFragment(` ${ok} `, 'WHERE'), ok, ok);
  const refused: [string, RegExp][] = [
    ['1 = 1; DROP TABLE t', /one expression/],
    ['(SELECT body FROM http("uri" = "http://169.254.169.254/latest/meta-data/"))', /'SELECT' is not allowed/],
    ['timestamp LIMIT 100000000 INTO OUTFILE "s3://bucket/x" FORMAT AS csv', /'LIMIT' is not allowed/],
    ['timestamp INTO OUTFILE "s3://bucket/x"', /'INTO' is not allowed/],
    ['duration -- rest of the query', /comments/],
    ['duration /* hint */', /comments/],
    ['duration # note', /comments/],
    ["R'\\' UNION SELECT 1 -- '", /backslashes/],
    ["body = 'unterminated", /unterminated string/],
    ['1 = 1) OR (1 = 1', /unbalanced/],
    ['((1 = 1)', /unbalanced/],
    ['1 IN (select 1)', /'select' is not allowed/],
    ['exists (with x as (values 1) table x)', /'with' is not allowed/],
  ];
  for (const [bad, re] of refused) assert.throws(() => sqlFragment(bad, 'WHERE'), re, bad);
  // Literal text is never inspected, quoted identifiers neither.
  assert.equal(sqlFragment("body = 'a; -- /* # SELECT FROM'", 'WHERE'), "body = 'a; -- /* # SELECT FROM'");
});
