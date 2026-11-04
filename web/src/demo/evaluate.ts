// In-browser evaluation of the search bar language over a snapshot of rows, for the offline
// demo. It parses with the server's parser and follows the compiler's rules (server/src/query/
// compile.ts) for each kind of column, so the demo answers the way Doris would:
//   fulltext  (body, span_name): lower-cased word tokens; terms, wildcards and regexes match a token
//   keyword   (ids, service, level...): the whole value, with case variants and value aliases
//   none      : SQL semantics (= / LIKE / REGEXP search)
//   number    : numeric comparison, unit suffixes on unit columns
// Absent attributes do not match a term, so NOT matches them (as `NOT coalesce(.., false)`).

import { type Node, type Segment, isWildcard, literalText } from '../../../server/src/query/ast.ts';
import { parseQuery } from '../../../server/src/query/parser.ts';
import type { Column, Source } from '../../../server/src/query/source.ts';

export type DemoRow = Record<string, unknown>;

interface Target {
  column: Column;
  path: string | null;
}

function resolve(source: Source, field: string | null): Target[] {
  const byName = (n: string) => source.columns.find((c) => c.name === n);
  if (field === null) return source.defaultFields.map((n) => ({ column: byName(n)!, path: null }));
  const name = source.aliases[field] ?? field;
  const exact = byName(name);
  if (exact) return [{ column: exact, path: null }];
  const variant = source.columns.find((c) => c.type === 'variant' && name.startsWith(`${c.name}.`));
  if (variant) return [{ column: variant, path: name.slice(variant.name.length + 1) }];
  return source.attributeColumns.map((n) => ({ column: byName(n)!, path: name }));
}

/** A dotted path in a parsed VARIANT object: nested keys first, then a literal dotted key. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') { cur = undefined; break; }
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur !== undefined) return cur;
  return obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[path] : undefined;
}

export function targetValue(row: DemoRow, t: Target): unknown {
  const v = row[t.column.name];
  return t.path === null ? v : getPath(v, t.path);
}

const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;
const tokenCache = new WeakMap<object, Map<string, string[]>>();
function tokens(row: DemoRow, col: string): string[] {
  let m = tokenCache.get(row);
  if (!m) tokenCache.set(row, (m = new Map()));
  let t = m.get(col);
  if (!t) m.set(col, (t = String(row[col] ?? '').toLowerCase().split(TOKEN_SPLIT).filter(Boolean)));
  return t;
}

function globRegex(segments: Segment[], flags = ''): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${segments.map((s) => ('lit' in s ? esc(s.lit) : s.any === '*' ? '.*' : '.')).join('')}$`, flags);
}

const UNIT = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(us|µs|ms|s|m|h)$/;
const MICROS: Record<string, number> = { us: 1, µs: 1, ms: 1000, s: 1e6, m: 6e7, h: 3.6e9 };
function toNumber(c: Column, v: string): number {
  const m = c.unit === 'us' ? UNIT.exec(v) : null;
  if (m) return Number(m[1]) * MICROS[m[2]!]!;
  const n = Number(v);
  if (!Number.isFinite(n) || v.trim() === '') throw new Error(`'${v}' is not a number (field ${c.name})`);
  return n;
}

const timeMs = (v: unknown) => Date.parse(`${String(v).replace(' ', 'T')}Z`);

function variants(c: Column, segments: Segment[]): Segment[][] {
  const text = literalText(segments);
  const alias = !isWildcard(segments) ? c.valueAliases?.[text.toLowerCase()] : undefined;
  const base: Segment[] = alias !== undefined ? [{ lit: alias }] : segments;
  if (!c.caseInsensitive) return [base];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const forms = [(x: string) => x.toUpperCase(), (x: string) => x.toLowerCase(), cap, (x: string) => x];
  return forms.map((f) => base.map((seg, i) => ('lit' in seg ? { lit: f === cap && i > 0 ? seg.lit.toLowerCase() : f(seg.lit) } : seg)));
}

type Leaf = Exclude<Node, { kind: 'and' | 'or' | 'not' }>;

function matchTarget(row: DemoRow, t: Target, n: Leaf): boolean {
  const c = t.column;
  if (n.kind === 'exists') return targetValue(row, t) !== null && targetValue(row, t) !== undefined;
  if (t.path === null && c.index === 'fulltext' && n.kind !== 'range') {
    const toks = tokens(row, c.name);
    if (n.kind === 'phrase') {
      const want = n.text.toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
      return want.length > 0 && toks.some((_, i) => want.every((w, j) => toks[i + j] === w));
    }
    if (n.kind === 'regex') {
      const re = new RegExp(`^(?:${n.pattern})$`);
      return toks.some((tk) => re.test(tk));
    }
    const lower = n.segments.map((s) => ('lit' in s ? { lit: s.lit.toLowerCase() } : s));
    if (!isWildcard(lower)) return toks.includes(literalText(lower));
    const re = globRegex(lower);
    return toks.some((tk) => re.test(tk));
  }
  const raw = targetValue(row, t);
  if (raw === null || raw === undefined) return false;
  if (n.kind === 'range') {
    const bounds = [n.lo, n.hi];
    let v: number | string;
    let lo: number | string | null;
    let hi: number | string | null;
    if (t.path === null && c.type === 'number') {
      v = Number(raw); lo = n.lo === null ? null : toNumber(c, n.lo); hi = n.hi === null ? null : toNumber(c, n.hi);
    } else if (t.path === null && c.type === 'datetime') {
      v = timeMs(raw); lo = n.lo === null ? null : timeMs(n.lo); hi = n.hi === null ? null : timeMs(n.hi);
    } else if (t.path !== null && bounds.every((b) => b === null || Number.isFinite(Number(b)))) {
      v = Number(raw); lo = n.lo === null ? null : Number(n.lo); hi = n.hi === null ? null : Number(n.hi);
      if (!Number.isFinite(v)) return false;
    } else {
      v = String(raw); lo = n.lo; hi = n.hi;
    }
    if (lo !== null && (n.loInclusive ? v < lo : v <= lo)) return false;
    if (hi !== null && (n.hiInclusive ? v > hi : v >= hi)) return false;
    return true;
  }
  if (t.path === null && c.type === 'number') {
    const text = n.kind === 'phrase' ? n.text : n.kind === 'term' ? literalText(n.segments) : null;
    if (text === null) throw new Error(`regular expressions are not allowed on field ${c.name}`);
    return Number(raw) === toNumber(c, text);
  }
  const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (n.kind === 'regex') return c.index === 'none' ? new RegExp(n.pattern).test(value) : new RegExp(`^(?:${n.pattern})$`).test(value);
  const segments: Segment[] = n.kind === 'phrase' ? [{ lit: n.text }] : n.segments;
  if (c.index === 'none' && n.kind === 'phrase') return value.includes(n.text);
  return variants(c, segments).some((v) => (isWildcard(v) ? globRegex(v).test(value) : value === literalText(v)));
}

function matchLeaf(source: Source, row: DemoRow, n: Leaf): boolean {
  if (resolve(source, n.field).some((t) => matchTarget(row, t, n))) return true;
  if (n.field === null && n.kind === 'term' && !isWildcard(n.segments)) {
    const text = literalText(n.segments);
    for (const id of source.idColumns ?? []) {
      if (id.pattern.test(text) && row[id.column] === text.toLowerCase()) return true;
    }
  }
  return false;
}

function matchNode(source: Source, row: DemoRow, n: Node): boolean {
  switch (n.kind) {
    case 'and': return matchNode(source, row, n.left) && matchNode(source, row, n.right);
    case 'or': return matchNode(source, row, n.left) || matchNode(source, row, n.right);
    case 'not': return !matchNode(source, row, n.child);
    default: return matchLeaf(source, row, n);
  }
}

/** A row filter for a search bar query; throws the parser's or a value error on bad input. */
export function compileFilter(source: Source, query: string): (row: DemoRow) => boolean {
  const ast = parseQuery(query);
  if (ast === null) return () => true;
  // Validate values once (bad numbers raise here, as the server answers 400).
  const check = (n: Node): void => {
    if (n.kind === 'and' || n.kind === 'or') { check(n.left); check(n.right); return; }
    if (n.kind === 'not') { check(n.child); return; }
    for (const t of resolve(source, n.field)) {
      if (t.path !== null || t.column.type !== 'number' || resolve(source, n.field).length > 1) continue;
      if (n.kind === 'term') toNumber(t.column, literalText(n.segments));
      if (n.kind === 'range') [n.lo, n.hi].forEach((b) => b !== null && toNumber(t.column, b));
    }
  };
  check(ast);
  return (row) => matchNode(source, row, ast);
}

/** The value of a field as a string, first attribute column that has it (like fieldExpr). */
export function fieldValue(source: Source, row: DemoRow, field: string): string | null {
  for (const t of resolve(source, field)) {
    const v = targetValue(row, t);
    if (v !== null && v !== undefined) return typeof v === 'string' ? v : JSON.stringify(v);
  }
  return null;
}
