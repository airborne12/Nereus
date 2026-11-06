// Full SELECT statements for the search page: result rows, the time histogram, one trace.
// Every statement bounds the time column so Doris prunes daily partitions.

import { CompileError, compileWhere, fieldExpr, numericFieldExpr, sqlString } from './compile.ts';
import type { Source } from './source.ts';

export interface TimeRange {
  /** Inclusive, UTC, "YYYY-MM-DD HH:MM:SS[.ffffff]" or ISO 8601 with Z. */
  from: string;
  /** Exclusive. */
  to: string;
}

const MAX_LIMIT = 10_000;

/** Parse a UTC timestamp into epoch milliseconds; accepts ISO 8601 or Doris DATETIME text. */
export function parseTime(s: string): number {
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}/.test(s)) throw new CompileError(`invalid time '${s}'`);
  return ms;
}

/** Doris DATETIME(6) literal for epoch milliseconds (UTC). */
function timeLiteral(ms: number): string {
  return sqlString(new Date(ms).toISOString().replace('T', ' ').replace('Z', ''));
}

function timeBounds(source: Source, range: TimeRange): { where: string; fromMs: number; toMs: number } {
  const fromMs = parseTime(range.from);
  const toMs = parseTime(range.to);
  if (toMs <= fromMs) throw new CompileError('time range is empty: to must be after from');
  const ts = source.timestampColumn;
  return { where: `${ts} >= ${timeLiteral(fromMs)} AND ${ts} < ${timeLiteral(toMs)}`, fromMs, toMs };
}

/** Bucket sizes the histogram may use, in seconds, with the Doris floor function for each. */
const STEPS: [number, string][] = [
  [1, 'second_floor(%s, 1)'], [5, 'second_floor(%s, 5)'], [10, 'second_floor(%s, 10)'],
  [30, 'second_floor(%s, 30)'], [60, 'minute_floor(%s, 1)'], [300, 'minute_floor(%s, 5)'],
  [600, 'minute_floor(%s, 10)'], [1800, 'minute_floor(%s, 30)'], [3600, 'hour_floor(%s, 1)'],
  [3 * 3600, 'hour_floor(%s, 3)'], [6 * 3600, 'hour_floor(%s, 6)'], [12 * 3600, 'hour_floor(%s, 12)'],
  [86400, 'day_floor(%s, 1)'], [7 * 86400, 'day_floor(%s, 7)'],
];

/** The smallest step that gives at most `maxBuckets` buckets over the range. */
export function histogramStep(fromMs: number, toMs: number, maxBuckets: number): [number, string] {
  const seconds = (toMs - fromMs) / 1000;
  return STEPS.find(([s]) => seconds / s <= maxBuckets) ?? STEPS.at(-1)!;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/** All spans of one trace. The time range keeps the lookup on a few partitions. */
export function traceSql(source: Source, traceId: string, range: TimeRange): string {
  if (!TRACE_ID_RE.test(traceId)) throw new CompileError('trace id must be 32 lowercase hex characters');
  const { where } = timeBounds(source, range);
  return `SELECT * FROM ${source.table} WHERE ${where} AND trace_id = ${sqlString(traceId)} ORDER BY timestamp`;
}

export interface ValuesRequest extends TimeRange {
  field: string;
  query: string;
  limit?: number;
}

/** Most frequent values of one field among the rows that match the query. */
export function valuesSql(source: Source, req: ValuesRequest): string {
  const limit = req.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CompileError('limit must be between 1 and 100');
  const { where } = timeBounds(source, req);
  const expr = fieldExpr(source, req.field);
  return `SELECT ${expr} AS v, count(*) AS n FROM ${source.table} WHERE ${where} AND ` +
    `${compileWhere(source, req.query)} AND ${expr} IS NOT NULL GROUP BY v ORDER BY n DESC LIMIT ${limit}`;
}

export interface Field {
  /** What to type in the search bar. */
  name: string;
  /** Doris type as DESC prints it, e.g. varchar(256), text, bigint. */
  type: string;
}

/**
 * Search bar fields from `DESC <table>` run with describe_extend_variant_column = true:
 * plain columns, aliases, and VARIANT sub-paths. Sub-paths of attribute columns are listed
 * without the column prefix, since the compiler looks unknown fields up in those columns.
 */
export function fieldsFromDescribe(source: Source, rows: { Field: string; Type: string }[]): Field[] {
  const out = new Map<string, Field>();
  for (const r of rows) {
    const variant = source.columns.find((c) => c.type === 'variant' && r.Field.startsWith(`${c.name}.`));
    if (variant) {
      const path = r.Field.slice(variant.name.length + 1);
      const name = source.attributeColumns.includes(variant.name) ? path : r.Field;
      if (!out.has(name)) out.set(name, { name, type: r.Type });
    } else if (source.columns.some((c) => c.name === r.Field && c.type !== 'variant')) {
      out.set(r.Field, { name: r.Field, type: r.Type });
    }
  }
  for (const [alias, target] of Object.entries(source.aliases)) {
    const t = out.get(target);
    if (t && !out.has(alias)) out.set(alias, { name: alias, type: t.type });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- search page model (ClickStack layout)
//
// A search is a WHERE text in Lucene or SQL, plus facet filters kept apart from that text (as
// pills), plus an optional SELECT list and ORDER BY. SQL fragments are the user's own SQL: they
// run as given, so give the API service a read-only Doris account (see README). One statement
// only: a ';' is refused.

export interface Filter {
  field: string;
  values: string[];
  /** true: rows with any of the values are dropped (rows without the field stay). */
  exclude?: boolean;
}

export interface SearchSpec extends TimeRange {
  where: string;
  language?: 'lucene' | 'sql';
  filters?: Filter[];
}

export function sqlFragment(s: string, what: string): string {
  if (s.includes(';')) throw new CompileError(`${what} must be a single SQL expression (no ';')`);
  return s.trim();
}

function filterSql(source: Source, f: Filter): string {
  if (!Array.isArray(f.values) || f.values.length === 0) throw new CompileError(`filter on ${f.field} has no values`);
  const set = `${fieldExpr(source, f.field)} IN (${f.values.map((v) => sqlString(String(v))).join(', ')})`;
  return f.exclude ? `NOT coalesce(${set}, false)` : set;
}

/** Time bounds, the WHERE text and the filters, ANDed. */
export function searchWhere(source: Source, spec: SearchSpec): string {
  const parts = [timeBounds(source, spec).where];
  if (spec.language === 'sql') {
    const w = sqlFragment(spec.where, 'WHERE');
    if (w) parts.push(`(${w})`);
  } else {
    const w = compileWhere(source, spec.where);
    if (w !== 'TRUE') parts.push(w);
  }
  for (const f of spec.filters ?? []) parts.push(filterSql(source, f));
  return parts.join(' AND ');
}

/** Split a SELECT list on top-level commas (not inside parentheses or quotes). */
export function splitSelect(select: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = '';
  for (let i = 0; i < select.length; i++) {
    const ch = select[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += select[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface ResultColumn {
  /** Header text: the expression as typed. */
  label: string;
  /** Key of the value in each row. */
  key: string;
}

const FIELD_NAME_RE = /^[A-Za-z_@][A-Za-z0-9_.@-]*$/;

/**
 * Rows always carry every column (the side panel needs the whole event); the SELECT list picks
 * what the table shows. A column name shows that column; a search bar field (level,
 * k8s.pod.name) or any other SQL expression is added as `__e<n>`.
 */
export function selectColumns(source: Source, select: string): { extra: string[]; columns: ResultColumn[] } {
  const extra: string[] = [];
  const columns: ResultColumn[] = [];
  splitSelect(sqlFragment(select, 'SELECT')).forEach((expr, i) => {
    if (source.columns.some((c) => c.name === expr)) {
      columns.push({ label: expr, key: expr });
      return;
    }
    const key = `__e${i}`;
    const sql = FIELD_NAME_RE.test(expr) ? fieldExpr(source, expr) : expr;
    extra.push(`${sql} AS ${key}`);
    columns.push({ label: expr, key });
  });
  return { extra, columns };
}

export interface SearchRowsRequest extends SearchSpec {
  select?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export function searchRowsSql(source: Source, req: SearchRowsRequest): { sql: string; columns: ResultColumn[] } {
  const limit = req.limit ?? 200;
  const offset = req.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new CompileError(`limit must be between 1 and ${MAX_LIMIT}`);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new CompileError('offset must be between 0 and 100000');
  const { extra, columns } = selectColumns(source, req.select?.trim() || defaultSelect(source));
  const order = sqlFragment(req.orderBy?.trim() || `${source.timestampColumn} DESC`, 'ORDER BY');
  const sql = `SELECT *${extra.map((e) => `, ${e}`).join('')} FROM ${source.table} WHERE ${searchWhere(source, req)} ` +
    `ORDER BY ${order} LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''}`;
  return { sql, columns };
}

/** The table's columns when SELECT is empty, as ClickStack's OTel sources show them. */
export function defaultSelect(source: Source): string {
  return source.name === 'traces'
    ? 'timestamp, service_name, status_code, round(duration / 1000, 1), span_name'
    : 'timestamp, service_name, severity_text, body';
}

/** Name of the series that gathers the groups past `maxGroups`. */
export const OTHER_GROUP = '(other)';

export function searchHistogramSql(source: Source, spec: SearchSpec & { maxBuckets?: number; groupBy?: string; maxGroups?: number }):
  { sql: string; stepSeconds: number } {
  const { fromMs, toMs } = timeBounds(source, spec);
  const [stepSeconds, floor] = histogramStep(fromMs, toMs, spec.maxBuckets ?? 120);
  const bucket = floor.replace('%s', source.timestampColumn);
  const group = spec.groupBy ? fieldExpr(source, spec.groupBy) : null;
  const where = searchWhere(source, spec);
  if (group && spec.maxGroups) {
    // The most frequent groups keep their own series; the rest add up under OTHER_GROUP. One scan:
    // groups are ranked by their total over the (bucket, group) counts, not by a second pass over
    // the table (5x faster than joining a top-N subquery at 100M rows).
    const sql = `SELECT t, if(rk <= ${Math.trunc(spec.maxGroups)}, g, ${sqlString(OTHER_GROUP)}) AS g, sum(n) AS n FROM (` +
      `SELECT t, g, n, dense_rank() OVER (ORDER BY tot DESC, g) AS rk FROM (` +
      `SELECT t, g, n, sum(n) OVER (PARTITION BY g) AS tot FROM (` +
      `SELECT ${bucket} AS t, ${group} AS g, count(*) AS n FROM ${source.table} WHERE ${where} GROUP BY t, g) a) b) c ` +
      `GROUP BY 1, 2 ORDER BY 1, 2`;
    return { sql, stepSeconds };
  }
  const select = group ? `${bucket} AS t, ${group} AS g, count(*) AS n` : `${bucket} AS t, count(*) AS n`;
  const sql = `SELECT ${select} FROM ${source.table} WHERE ${where} ` +
    `GROUP BY t${group ? ', g' : ''} ORDER BY t${group ? ', g' : ''}`;
  return { sql, stepSeconds };
}

const FACET_SAMPLE = 20_000;

/**
 * Top values of several fields at once, from a sample of the newest matching rows (counts are
 * within the sample, which `__sampled` reports). topn() returns a JSON object value -> count.
 */
export function facetsSql(source: Source, spec: SearchSpec, fields: string[]): string {
  if (fields.length === 0 || fields.length > 60) throw new CompileError('ask for 1 to 60 facet fields');
  // The sample reads only the faceted expressions: SELECT * would read every column, whole VARIANT
  // and ARRAY columns included, for each of the sampled rows.
  const exprs = fields.map((f, i) => `${fieldExpr(source, f)} AS f${i}`);
  const tops = fields.map((_, i) => `topn(f${i}, 10) AS f${i}`);
  return `SELECT count(*) AS __sampled, ${tops.join(', ')} FROM (SELECT ${exprs.join(', ')} FROM ${source.table} ` +
    `WHERE ${searchWhere(source, spec)} ORDER BY ${source.timestampColumn} DESC LIMIT ${FACET_SAMPLE}) s`;
}

const PRIMARY_FACETS = ['service_name', 'severity_text', 'status_code', 'span_kind', 'span_name'];

const NOT_FACETS = new Set(['timestamp', 'end_time', 'trace_id', 'span_id', 'parent_span_id', 'body', 'trace_state',
  'status_message', 'duration', 'severity_number', 'is_root']);

/** Fields the filter panel lists by default: string columns and attribute paths, ids and text left out. */
export function defaultFacetFields(source: Source, fields: Field[]): string[] {
  // The fields people filter on most first, then other columns in table order, then attribute paths by name.
  const rank = (name: string) => {
    const p = PRIMARY_FACETS.indexOf(name);
    if (p >= 0) return p - PRIMARY_FACETS.length;
    const i = source.columns.findIndex((c) => c.name === name);
    return i < 0 ? source.columns.length : i;
  };
  return fields
    .filter((f) => /^(varchar|char|text|string)/i.test(f.type))
    .filter((f) => !NOT_FACETS.has(f.name) && !(f.name in source.aliases))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map((f) => f.name);
}

// ---------------------------------------------------------------- charts (Chart explorer, dashboard tiles)

export type Aggregate = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p90' | 'p95' | 'p99';
export const AGGREGATES: Aggregate[] = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'p50', 'p90', 'p95', 'p99'];

export interface Series {
  agg: Aggregate;
  /** The field aggregated; not used by count. */
  field?: string;
}

export interface ChartSpec extends SearchSpec {
  display: 'line' | 'table' | 'number';
  series: Series[];
  groupBy?: string;
  maxBuckets?: number;
}

function aggregateSql(source: Source, s: Series): string {
  if (!AGGREGATES.includes(s.agg)) throw new CompileError(`unknown aggregate '${s.agg}'`);
  if (s.agg === 'count') return 'count(*)';
  if (!s.field) throw new CompileError(`${s.agg} needs a field`);
  if (s.agg === 'count_distinct') return `approx_count_distinct(${fieldExpr(source, s.field)})`;
  const num = numericFieldExpr(source, s.field);
  if (s.agg.startsWith('p')) return `percentile_approx(${num}, ${Number(s.agg.slice(1)) / 100})`;
  return `${s.agg}(${num})`;
}

/**
 * One query per chart. Lines: a row per time bucket (and group) with v0..vn. Tables: a row per group
 * (top 100 by the first series). Numbers: one row.
 */
export function chartSql(source: Source, spec: ChartSpec): { sql: string; stepSeconds: number | null } {
  if (!Array.isArray(spec.series) || spec.series.length === 0 || spec.series.length > 10) {
    throw new CompileError('a chart needs 1 to 10 series');
  }
  const values = spec.series.map((s, i) => `${aggregateSql(source, s)} AS v${i}`).join(', ');
  const where = searchWhere(source, spec);
  const group = spec.groupBy ? fieldExpr(source, spec.groupBy) : null;
  if (spec.display === 'number') {
    return { sql: `SELECT ${values} FROM ${source.table} WHERE ${where}`, stepSeconds: null };
  }
  if (spec.display === 'table') {
    const sql = group
      ? `SELECT ${group} AS g, ${values} FROM ${source.table} WHERE ${where} GROUP BY g ORDER BY v0 DESC LIMIT 100`
      : `SELECT ${values} FROM ${source.table} WHERE ${where}`;
    return { sql, stepSeconds: null };
  }
  if (spec.display !== 'line') throw new CompileError(`unknown display '${String(spec.display)}'`);
  const { fromMs, toMs } = timeBounds(source, spec);
  const [stepSeconds, floor] = histogramStep(fromMs, toMs, spec.maxBuckets ?? 60);
  const bucket = floor.replace('%s', source.timestampColumn);
  const sql = `SELECT ${bucket} AS t${group ? `, ${group} AS g` : ''}, ${values} FROM ${source.table} WHERE ${where} ` +
    `GROUP BY t${group ? ', g' : ''} ORDER BY t LIMIT 10000`;
  return { sql, stepSeconds };
}

/** Matches of a saved search in a window: the number an alert compares with its threshold. */
export function countSql(source: Source, spec: SearchSpec): string {
  return `SELECT count(*) AS n FROM ${source.table} WHERE ${searchWhere(source, spec)}`;
}

// ---------------------------------------------------------------- service map, heatmap (Event Deltas)

/**
 * Calls between services: a child span whose parent span belongs to another service is one call
 * from the parent's service to the child's. Parents are looked up a minute either side of the
 * window so calls that cross its edge still join.
 */
export function serviceMapSql(traces: Source, spec: SearchSpec): { edges: string; nodes: string } {
  const { fromMs, toMs } = timeBounds(traces, spec);
  const lit = (ms: number) => sqlString(new Date(ms).toISOString().replace('T', ' ').replace('Z', ''));
  const childWhere = searchWhere(traces, spec);
  const t = traces.table;
  const edges = `SELECT p.service_name AS src, c.service_name AS dst, count(*) AS calls, ` +
    `sum(if(c.status_code = 'STATUS_CODE_ERROR', 1, 0)) AS errors, ` +
    `percentile_approx(c.duration, 0.5) AS p50, percentile_approx(c.duration, 0.99) AS p99 ` +
    `FROM (SELECT trace_id, parent_span_id, service_name, status_code, duration FROM ${t} WHERE ${childWhere} AND parent_span_id <> '') c ` +
    `JOIN (SELECT trace_id, span_id, service_name FROM ${t} WHERE timestamp >= ${lit(fromMs - 60_000)} AND timestamp < ${lit(toMs + 60_000)}) p ` +
    `ON c.trace_id = p.trace_id AND c.parent_span_id = p.span_id ` +
    `WHERE c.service_name <> p.service_name GROUP BY src, dst ORDER BY calls DESC LIMIT 500`;
  // A service's requests are its entry spans: roots and server spans.
  const nodes = `SELECT service_name AS service, count(*) AS requests, ` +
    `sum(if(status_code = 'STATUS_CODE_ERROR', 1, 0)) AS errors, percentile_approx(duration, 0.99) AS p99 ` +
    `FROM ${t} WHERE ${childWhere} AND (is_root = 1 OR span_kind = 'SPAN_KIND_SERVER') GROUP BY service ORDER BY requests DESC LIMIT 200`;
  return { edges, nodes };
}

/** Duration bands for the heatmap: 4 per power of ten of microseconds. */
export const HEAT_BANDS_PER_DECADE = 4;

/** Counts per time bucket and duration band, for Event Deltas' heatmap. */
export function heatmapSql(traces: Source, spec: SearchSpec & { maxBuckets?: number }): { sql: string; stepSeconds: number } {
  const { fromMs, toMs } = timeBounds(traces, spec);
  const [stepSeconds, floor] = histogramStep(fromMs, toMs, spec.maxBuckets ?? 60);
  const bucket = floor.replace('%s', traces.timestampColumn);
  const sql = `SELECT ${bucket} AS t, floor(log10(greatest(duration, 1)) * ${HEAT_BANDS_PER_DECADE}) AS b, count(*) AS n ` +
    `FROM ${traces.table} WHERE ${searchWhere(traces, spec)} GROUP BY t, b ORDER BY t, b`;
  return { sql, stepSeconds };
}
