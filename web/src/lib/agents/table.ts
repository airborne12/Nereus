// The state of an agent table page, kept in the address: the time range, the search, the
// conditions, the sort and the columns shown. Conditions are stored as the API takes them.

import type { TableQuery } from '../../api/agents.ts';
import { duration, tokens } from './format.ts';
import { type CellKind, columnOf, type PageDef } from './pages.ts';

export const RANGE_PRESETS = ['1h', '24h', '7d', '30d'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
/** A range ending now, or a fixed one in epoch ms. */
export type TableRange = { preset: RangePreset } | { from: number; to: number };

export const PRESET_LABEL: Record<RangePreset, string> = { '1h': 'Past 1 hour', '24h': 'Past 24 hours', '7d': 'Past 7 days', '30d': 'Past 30 days' };
const PRESET_MS: Record<RangePreset, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
export const DEFAULT_PRESET: RangePreset = '7d';
/** Rows a page reads at a time. */
export const PAGE_ROWS = 100;
/** The largest time a date holds, in ms either side of 1970. */
const MAX_TIME = 8.64e15;

export type Op = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains';
const OPS: readonly Op[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'contains'];
export const OP_SIGN: Record<Op, string> = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥', contains: 'contains' };

export interface Condition { column: string; op: Op; value: string }

export interface TableState {
  range: TableRange;
  q: string;
  conditions: Condition[];
  sort: string;
  dir: 'asc' | 'desc';
  /** Names of the columns shown; null for the page's default. */
  columns: string[] | null;
}

export const defaultState = (def: PageDef): TableState =>
  ({ range: { preset: DEFAULT_PRESET }, q: '', conditions: [], sort: def.defaultSort, dir: 'desc', columns: null });

export function resolveRange(r: TableRange, now: number): { from: number; to: number } {
  return 'preset' in r ? { from: now - PRESET_MS[r.preset], to: now } : { from: r.from, to: r.to };
}

/** A condition as the API takes it: `column:op:value`. */
export const conditionParam = (c: Condition): string => `${c.column}:${c.op}:${c.value}`;

function parseCondition(raw: string, def: PageDef): Condition | null {
  const m = /^([a-z_]+):([a-z]+):(.*)$/s.exec(raw);
  if (!m || !columnOf(def, m[1]!) || !(OPS as readonly string[]).includes(m[2]!)) return null;
  return { column: m[1]!, op: m[2] as Op, value: m[3]! };
}

/** The time range an address holds: `t` for a range ending now, or `from` and `to` in epoch ms. */
export function parseRange(p: URLSearchParams): TableRange {
  const preset = p.get('t');
  const from = Number(p.get('from'));
  const to = Number(p.get('to'));
  // A fixed range must fit what a date can hold, or no request could be built from it.
  const fits = Number.isFinite(from) && Number.isFinite(to) && to > from && from >= -MAX_TIME && to <= MAX_TIME;
  return (RANGE_PRESETS as readonly string[]).includes(preset ?? '') ? { preset: preset as RangePreset }
    : p.has('from') && fits ? { from, to } : { preset: DEFAULT_PRESET };
}

/** The parameters of an address that say a time range; the default range needs none. */
export function rangeParams(range: TableRange): [string, string][] {
  if ('preset' in range) return range.preset === DEFAULT_PRESET ? [] : [['t', range.preset]];
  return [['from', String(Math.round(range.from))], ['to', String(Math.round(range.to))]];
}

/** The state an address holds; anything it does not say, or says wrongly, is the page's default. */
export function parseTableState(search: string, def: PageDef): TableState {
  const p = new URLSearchParams(search);
  const base = defaultState(def);
  const range = parseRange(p);
  const sort = p.get('sort');
  const cols = (p.get('cols') ?? '').split(',').filter((name) => columnOf(def, name));
  return {
    range,
    q: p.get('q') ?? '',
    conditions: p.getAll('f').map((raw) => parseCondition(raw, def)).filter((c): c is Condition => c !== null),
    sort: sort && columnOf(def, sort) ? sort : base.sort,
    dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
    columns: cols.length ? cols : null,
  };
}

/** The query string of a state; what equals the default is left out. */
export function serializeTableState(s: TableState, def: PageDef): string {
  const p = new URLSearchParams(rangeParams(s.range));
  if (s.q.trim()) p.set('q', s.q.trim());
  for (const c of s.conditions) p.append('f', conditionParam(c));
  if (s.sort !== def.defaultSort) p.set('sort', s.sort);
  if (s.dir !== 'desc') p.set('dir', s.dir);
  if (s.columns) p.set('cols', s.columns.join(','));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** The request of a state for one page of rows. */
export function queryOf(s: TableState, now: number, offset: number): TableQuery {
  const { from, to } = resolveRange(s.range, now);
  return { from, to, q: s.q, conditions: s.conditions.map(conditionParam), sort: s.sort, dir: s.dir, limit: PAGE_ROWS, offset };
}

/** The comparisons a condition on a column of this kind offers; none for a time, which the range covers. */
export function opsOf(kind: CellKind): Op[] {
  if (kind === 'time') return [];
  if (kind === 'text') return ['contains', 'eq'];
  if (kind === 'enum') return ['eq', 'ne'];
  return ['ge', 'le', 'eq'];
}

/** The unit a condition's value is typed in, shown beside the value box. */
export function unitOf(kind: CellKind): string {
  return kind === 'duration' ? 'seconds' : kind === 'tokens' ? 'tokens' : kind === 'percent' ? '%' : '';
}

/**
 * A condition from what the form holds, or a message saying what is wrong. A duration is typed in
 * seconds and stored in microseconds, as the API compares it.
 */
export function conditionFrom(def: PageDef, column: string, op: Op, raw: string): Condition | string {
  const c = columnOf(def, column);
  if (!c || !opsOf(c.kind).includes(op)) return 'Choose a column and a comparison.';
  const value = raw.trim();
  if (value === '') return 'Type a value.';
  if (c.kind === 'text' || c.kind === 'enum') return { column, op, value };
  if (!/^\d+(\.\d+)?$/.test(value)) return `${c.label} is compared with a number.`;
  return { column, op, value: c.kind === 'duration' ? String(Math.round(Number(value) * 1e6)) : value };
}

/** A condition in the words of the page: `Latency ≥ 5.0s`, `Status = failed`. */
export function conditionLabel(def: PageDef, c: Condition): string {
  const column = columnOf(def, c.column);
  const kind = column?.kind ?? 'text';
  const n = Number(c.value);
  const value = kind === 'duration' ? duration(n) : kind === 'tokens' ? tokens(n) : kind === 'percent' ? `${c.value}%` : c.value;
  return `${column?.label ?? c.column} ${OP_SIGN[c.op]} ${value}`;
}

/**
 * What the search box holds once the address has a search: what is being typed when it says the
 * same search, since the address stores it trimmed; otherwise the search of the address.
 */
export function syncDraft(draft: string, q: string): string {
  return draft.trim() === q.trim() ? draft : q;
}

/** Sorting by a column: newest or largest first, and the other way on a second click. */
export function sortBy(s: TableState, column: string): TableState {
  return { ...s, sort: column, dir: s.sort === column && s.dir === 'desc' ? 'asc' : 'desc' };
}

/** The filter of a page in words, as the export dialog names what it writes. */
export function filterText(def: PageDef, s: TableState, stamp: (ms: number) => string): string {
  const range = 'preset' in s.range ? PRESET_LABEL[s.range.preset] : `${stamp(s.range.from)} to ${stamp(s.range.to)}`;
  return [range, ...(s.q.trim() ? [`search "${s.q.trim()}"`] : []), ...s.conditions.map((c) => conditionLabel(def, c))].join(' · ');
}
