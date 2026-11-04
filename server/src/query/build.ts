// Full SELECT statements for the search page: result rows, the time histogram, one trace.
// Every statement bounds the time column so Doris prunes daily partitions.

import { CompileError, compileWhere, sqlString } from './compile.ts';
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

function projection(source: Source, columns: string[] | undefined): string {
  if (!columns || columns.length === 0) return '*';
  for (const c of columns) {
    if (!source.columns.some((col) => col.name === c)) throw new CompileError(`unknown column '${c}'`);
  }
  return columns.join(', ');
}

export interface RowsRequest extends TimeRange {
  query: string;
  limit?: number;
  columns?: string[];
}

/** Newest rows first. */
export function rowsSql(source: Source, req: RowsRequest): string {
  const limit = req.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CompileError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const { where } = timeBounds(source, req);
  return `SELECT ${projection(source, req.columns)} FROM ${source.table} ` +
    `WHERE ${where} AND ${compileWhere(source, req.query)} ` +
    `ORDER BY ${source.timestampColumn} DESC LIMIT ${limit}`;
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

export interface HistogramRequest extends TimeRange {
  query: string;
  maxBuckets?: number;
  /** Optional column to split counts by, e.g. severity_text. */
  groupBy?: string;
}

export function histogramSql(source: Source, req: HistogramRequest): { sql: string; stepSeconds: number } {
  const { where, fromMs, toMs } = timeBounds(source, req);
  const [stepSeconds, floor] = histogramStep(fromMs, toMs, req.maxBuckets ?? 120);
  const bucket = floor.replace('%s', source.timestampColumn);
  let group = '';
  if (req.groupBy !== undefined) {
    const col = source.columns.find((c) => c.name === req.groupBy);
    if (!col || col.type !== 'string') throw new CompileError(`cannot group by '${req.groupBy}'`);
    group = col.name;
  }
  const select = group ? `${bucket} AS t, ${group} AS g, count(*) AS n` : `${bucket} AS t, count(*) AS n`;
  const sql = `SELECT ${select} FROM ${source.table} WHERE ${where} AND ${compileWhere(source, req.query)} ` +
    `GROUP BY t${group ? ', g' : ''} ORDER BY t${group ? ', g' : ''}`;
  return { sql, stepSeconds };
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/** All spans of one trace. The time range keeps the lookup on a few partitions. */
export function traceSql(source: Source, traceId: string, range: TimeRange): string {
  if (!TRACE_ID_RE.test(traceId)) throw new CompileError('trace id must be 32 lowercase hex characters');
  const { where } = timeBounds(source, range);
  return `SELECT * FROM ${source.table} WHERE ${where} AND trace_id = ${sqlString(traceId)} ORDER BY timestamp`;
}
