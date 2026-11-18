// The request shape the agent table pages share (spec 7) and the SQL built from it: a time range,
// search terms, conditions, sort and paging, checked against the page's column catalogue. Column
// expressions come only from the catalogue; user text only ever appears inside escaped literals.

import { parseTime } from '../search/build.ts';
import { CompileError, sqlString } from '../search/compile.ts';

/** One statement that ran, as the SQL dialog shows it. */
export interface Statement { title: string; sql: string }

export type ColumnKind = 'text' | 'number' | 'time';

export interface PageColumn {
  /** Name in requests, results and exported files. */
  name: string;
  expr: string;
  kind: ColumnKind;
  /** A tokenized index on `expr`: `contains` uses MATCH_PHRASE instead of a substring scan. */
  indexed?: boolean;
  /** Long text: list rows carry the first PREVIEW_CHARS characters; exports carry all of it. */
  long?: boolean;
}

export interface Page {
  name: string;
  /** FROM and JOIN lines; `range(col)` bounds a joined table's time column, `terms` are the search terms. */
  from: (range: (col: string) => string, terms: readonly string[]) => string[];
  /** Conditions every row of the page meets. */
  fixed: string[];
  /** Expression of the time column the range applies to. */
  time: string;
  /** Catalogue names that identify a row; they break ties in the sort. */
  keys: string[];
  /** The condition one search term adds, or null when `from` joins on the terms. */
  search: ((term: string) => string) | null;
  columns: PageColumn[];
  defaultSort: string;
}

export type Op = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains';
export interface Condition { column: string; op: Op; value: string }

export interface TableRequest {
  from: string;
  to: string;
  q: string;
  conditions: Condition[];
  sort?: string;
  dir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export const PAGE_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const PREVIEW_CHARS = 1000;
/** Search terms a request may carry; each can add a join. */
export const MAX_TERMS = 8;

const OPS: Record<Op, string> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=', contains: '' };

/** Words of a search, all of which must match; text in double quotes is one phrase. */
export function parseTerms(q: string): string[] {
  const terms = [...q.matchAll(/"([^"]*)"?|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
  if (terms.length > MAX_TERMS) throw new CompileError(`at most ${MAX_TERMS} search terms`);
  return terms;
}

/** A condition written `column:op:value`; the value may contain colons. */
export function parseCondition(raw: string): Condition {
  const m = /^([a-z_]+):([a-z]+):(.*)$/s.exec(raw);
  if (!m) throw new CompileError(`condition '${raw}' must be column:op:value`);
  const op = m[2] as Op;
  if (!(op in OPS)) throw new CompileError(`unknown comparison '${m[2]}'; use ${Object.keys(OPS).join(', ')}`);
  return { column: m[1]!, op, value: m[3]! };
}

/** A Doris DATETIME(6) literal for epoch milliseconds (UTC). */
export function timeLiteral(ms: number): string {
  return sqlString(new Date(ms).toISOString().replace('T', ' ').replace('Z', ''));
}

/** The time range of a request as a condition maker; joined tables get one more day after `to`. */
export function timeRange(from: string, to: string): { cond: (col: string) => string; loose: (col: string) => string } {
  const fromMs = parseTime(from);
  const toMs = parseTime(to);
  if (toMs <= fromMs) throw new CompileError('time range is empty: to must be after from');
  return {
    cond: (col) => `${col} >= ${timeLiteral(fromMs)} AND ${col} < ${timeLiteral(toMs)}`,
    // Tool calls and blocks of a step may end after the step's start falls in the range.
    loose: (col) => `${col} >= ${timeLiteral(fromMs)} AND ${col} < ${timeLiteral(toMs + 86_400_000)}`,
  };
}

export function columnOf(page: Page, name: string): PageColumn {
  const c = page.columns.find((x) => x.name === name);
  if (!c) throw new CompileError(`unknown column '${name}' on ${page.name}`);
  return c;
}

const grouped = (expr: string) => (/^[\w.`]+$/.test(expr) ? expr : `(${expr})`);

function conditionSql(page: Page, c: Condition): string {
  const col = columnOf(page, c.column);
  if (c.op === 'contains') {
    if (col.kind !== 'text') throw new CompileError(`'contains' needs a text column, not ${c.column}`);
    return col.indexed ? `${col.expr} MATCH_PHRASE ${sqlString(c.value)}` : `instr(lower(${col.expr}), ${sqlString(c.value.toLowerCase())}) > 0`;
  }
  let value: string;
  if (col.kind === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(c.value)) throw new CompileError(`'${c.value}' is not a number (column ${c.column})`);
    value = c.value;
  } else if (col.kind === 'time') value = timeLiteral(parseTime(c.value));
  else value = sqlString(c.value);
  return `${grouped(col.expr)} ${OPS[c.op]} ${value}`;
}

/** FROM lines and WHERE conditions of a request on a page. */
export function filterOf(page: Page, req: TableRequest): { from: string[]; where: string[] } {
  const range = timeRange(req.from, req.to);
  const terms = parseTerms(req.q);
  const search = page.search;
  return {
    from: page.from(range.loose, terms),
    where: [...page.fixed, range.cond(page.time), ...(search ? terms.map(search) : []), ...req.conditions.map((c) => conditionSql(page, c))],
  };
}

function orderOf(page: Page, req: TableRequest): string {
  const name = req.sort ?? page.defaultSort;
  const by = columnOf(page, name);
  const dir = req.dir ?? 'desc';
  const ties = page.keys.filter((k) => k !== name).map((k) => columnOf(page, k).expr);
  return [`${by.expr} ${dir.toUpperCase()}`, ...ties].join(', ');
}

/**
 * The rows and the total of a page. A list carries one page of rows with long text cut; an
 * export carries every row and all of its text, up to `cap` + 1 rows so an overflow shows.
 */
export function tableSql(page: Page, req: TableRequest, mode: 'list' | 'export', cap = 0): { rows: Statement; total: Statement } {
  const { from, where } = filterOf(page, req);
  const select = page.columns.map((c) => `${mode === 'list' && c.long ? `left(${c.expr}, ${PREVIEW_CHARS})` : c.expr} AS \`${c.name}\``);
  const body = `${from.join('\n')}\nWHERE ${where.join('\n  AND ')}`;
  const limit = mode === 'list' ? `LIMIT ${Math.trunc(req.limit)} OFFSET ${Math.trunc(req.offset)}` : `LIMIT ${Math.trunc(cap) + 1}`;
  return {
    rows: { title: 'Rows', sql: `SELECT ${select.join(',\n       ')}\n${body}\nORDER BY ${orderOf(page, req)}\n${limit}` },
    total: { title: 'Total', sql: `SELECT count(*) AS total\n${body}` },
  };
}
