// Times the queries the UI sends, built by the server's own SQL builders, against a database such
// as otel_scale (see bench/SCALE.md). Each query runs RUNS times on one connection with the SQL
// cache off; the first run and the median of the others are reported.
//
//   PATH=/opt/doris/node/bin:$PATH DORIS_PORT=9930 DORIS_DB=otel_scale node bench/ui-queries.ts  (from server/) [filter] > results.json

import mysql from 'mysql2/promise';
import {
  chartSql, defaultFacetFields, facetsSql, fieldsFromDescribe, heatmapSql, searchHistogramSql, searchRowsSql, serviceMapSql,
  traceSql, valuesSql,
} from '../src/query/build.ts';
import { logsSource, tracesSource } from '../src/query/source.ts';

const DB = process.env.DORIS_DB ?? 'otel_scale';
const RUNS = Number(process.env.RUNS ?? 4);
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;

const conn = await mysql.createConnection({
  host: process.env.DORIS_HOST ?? '127.0.0.1', port: Number(process.env.DORIS_PORT ?? 9030), user: process.env.DORIS_USER ?? 'root',
  password: process.env.DORIS_PASSWORD ?? '', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
});
// As the server's pool sets them (server/src/db.ts), plus no result cache so every run executes.
await conn.query('SET inverted_index_skip_threshold = 0, query_timeout = 300, describe_extend_variant_column = true');
await conn.query('SET enable_sql_cache = false');

const logs = logsSource(DB), traces = tracesSource(DB);
const [[{ t: newest }]] = (await conn.query(`SELECT max(timestamp) AS t FROM ${DB}.otel_logs`)) as unknown as [[{ t: string }]];
const end = Date.parse(`${newest.replace(' ', 'T')}Z`) + 1000;
const WINDOWS: [string, number][] = [['15m', 15 * 60_000], ['1h', 3600_000], ['24h', 86400_000], ['7d', 7 * 86400_000]];
const range = (ms: number) => ({ from: new Date(end - ms).toISOString(), to: new Date(end).toISOString() });
const fieldsOf = async (table: string, src: typeof logs) => fieldsFromDescribe(src, (await conn.query(`DESC ${table}`))[0] as never);
const logFacets = defaultFacetFields(logs, await fieldsOf(logs.table, logs)).slice(0, 40);
const traceFacets = defaultFacetFields(traces, await fieldsOf(traces.table, traces)).slice(0, 40);
const [[{ id: someTrace }]] = (await conn.query(`SELECT trace_id AS id FROM ${DB}.otel_traces WHERE timestamp >= '${range(3600_000).from.replace('T', ' ').replace('Z', '')}' AND is_root = 1 LIMIT 1`)) as unknown as [[{ id: string }]];

interface Case { name: string; sql: string }
const cases: Case[] = [];
const searches: [string, typeof logs, string][] = [
  ['logs all', logs, ''],
  ['logs level:error service:checkout', logs, 'level:error service:checkout'],
  ['logs text "slow query"', logs, '"slow query on table"'],
  ['logs attribute', logs, 'k8s.pod.name:cart-2'],
  ['traces all', traces, ''],
  ['traces duration:>50ms', traces, 'duration:>50ms'],
  ['traces status:error service:payment', traces, 'status:error service:payment'],
];
for (const [label, w] of WINDOWS) {
  const r = range(w);
  for (const [name, src, where] of searches) {
    const spec = { where, language: 'lucene' as const, filters: [], ...r };
    cases.push({ name: `${name} | rows | ${label}`, sql: searchRowsSql(src, { ...spec, limit: 200 }).sql });
    cases.push({ name: `${name} | histogram | ${label}`, sql: searchHistogramSql(src, { ...spec, maxBuckets: 90, groupBy: src === logs ? 'severity_text' : 'status_code' }).sql });
    cases.push({ name: `${name} | facets | ${label}`, sql: facetsSql(src, spec, src === logs ? logFacets : traceFacets) });
  }
  const all = { where: '', language: 'lucene' as const, filters: [], ...r };
  cases.push({ name: `logs | group by service (top 10) | ${label}`, sql: searchHistogramSql(logs, { ...all, maxBuckets: 90, groupBy: 'service_name', maxGroups: 10 }).sql });
  cases.push({ name: `traces | order by duration desc | ${label}`, sql: searchRowsSql(traces, { ...all, orderBy: 'duration DESC', limit: 200 }).sql });
  cases.push({ name: `values service_name | ${label}`, sql: valuesSql(logs, { field: 'service_name', query: '', ...r }) });
  cases.push({ name: `patterns sample 2000 | ${label}`, sql: searchRowsSql(logs, { ...all, select: 'timestamp, body', limit: 2000 }).sql });
  const map = serviceMapSql(traces, all);
  cases.push({ name: `service map edges | ${label}`, sql: map.edges });
  cases.push({ name: `service map nodes | ${label}`, sql: map.nodes });
  cases.push({ name: `heatmap | ${label}`, sql: heatmapSql(traces, { ...all, maxBuckets: 60 }).sql });
  cases.push({ name: `chart p99 by service | ${label}`, sql: chartSql(traces, { ...all, display: 'line', series: [{ agg: 'p99', field: 'duration' }], groupBy: 'service' }).sql! });
  cases.push({ name: `chart count by level table | ${label}`, sql: chartSql(logs, { ...all, display: 'table', series: [{ agg: 'count' }], groupBy: 'level' }).sql! });
}
cases.push({ name: 'trace waterfall | ±1d', sql: traceSql(traces, someTrace, range(2 * 86400_000)) });
cases.push({ name: 'logs of a trace | ±1d', sql: searchRowsSql(logs, { where: `trace:${someTrace}`, language: 'lucene', filters: [], ...range(2 * 86400_000), orderBy: 'timestamp ASC', limit: 1000 }).sql });

const out: { name: string; first: number; median: number; rows: number }[] = [];
for (const c of cases.filter((x) => !only || only.test(x.name))) {
  const times: number[] = [];
  let rows = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const [r] = await conn.query(c.sql);
    times.push(performance.now() - t0);
    rows = (r as unknown[]).length;
  }
  const rest = times.slice(1).sort((a, b) => a - b);
  const res = { name: c.name, first: Math.round(times[0]!), median: Math.round(rest[Math.floor(rest.length / 2)] ?? times[0]!), rows };
  out.push(res);
  console.error(`${String(res.median).padStart(6)} ms (first ${String(res.first).padStart(6)})  ${c.name}  [${rows} rows]`);
}
console.log(JSON.stringify(out, null, 2));
await conn.end();
