// Compile a parsed search bar query into a Doris SQL boolean expression.
//
// Each leaf is compiled either into Doris search() DSL (inverted-index terms, phrases,
// wildcards, regexes) or into a plain SQL predicate. Adjacent DSL leaves are merged into one
// search() call. Plain SQL is used for:
//   * ranges and comparisons: search() RANGE/LIST clauses are not implemented in Doris and
//     silently match nothing (function_search.cpp falls back to a TERM query on "[a TO b]");
//   * number and datetime columns;
//   * columns without an inverted index, which search() rejects.
// Callers must run the SQL with `inverted_index_skip_threshold = 0`, or a BKD clause that hits
// more than half of a segment makes search() fail ("cannot fall back to row execution").
//
// Column names come from the Source; user text only ever appears inside escaped literals.

import { type Node, type Segment, isWildcard, literalText } from './ast.ts';
import { parseQuery } from './parser.ts';
import type { Column, Source } from './source.ts';

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

type Frag = { dsl: string } | { sql: string };

interface Target {
  column: Column;
  /** Sub-path inside a VARIANT column, e.g. "k8s.pod.name". */
  path: string | null;
}

// ---------------------------------------------------------------- literals and escaping

/** A Doris SQL string literal. */
export function sqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const DSL_SPECIAL = new Set([...'\\+-!(){}[]^"~*?:/&| \t\n\r']);

function dslEscape(s: string): string {
  let out = '';
  for (const ch of s) out += DSL_SPECIAL.has(ch) ? `\\${ch}` : ch;
  return out;
}

function dslTerm(segments: Segment[]): string {
  return segments.map((s) => ('lit' in s ? dslEscape(s.lit) : s.any)).join('');
}

function dslPhrase(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function dslRegex(pattern: string): string {
  return `/${pattern.replace(/\//g, '\\/')}/`;
}

/** A LIKE pattern: wildcards become % and _, literal %, _ and \ are escaped. */
function likePattern(segments: Segment[]): string {
  return segments
    .map((s) => ('lit' in s ? s.lit.replace(/[\\%_]/g, (c) => `\\${c}`) : s.any === '*' ? '%' : '_'))
    .join('');
}

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?$/;

function numberLiteral(v: string, field: string): string {
  if (!NUMBER_RE.test(v)) throw new CompileError(`'${v}' is not a number (field ${field})`);
  return v;
}

const UNIT_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(us|µs|ms|s|m|h)$/;
const MICROS: Record<string, number> = { us: 1, µs: 1, ms: 1000, s: 1e6, m: 6e7, h: 3.6e9 };

/** A number for column `c`; a column with a unit also takes 50ms, 1.5s, 250us, 2m. */
function columnNumber(c: Column, v: string): string {
  const m = c.unit === 'us' ? UNIT_RE.exec(v) : null;
  if (m) return String(Math.round(Number(m[1]) * MICROS[m[2]!]!));
  if (c.unit === 'us' && !NUMBER_RE.test(v)) {
    throw new CompileError(`'${v}' is not a duration (field ${c.name}: a number of microseconds, or 50ms, 1.5s, 2m)`);
  }
  return numberLiteral(v, c.name);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * The stored values a typed value stands for: an alias (error -> STATUS_CODE_ERROR) and, on a
 * case-insensitive column, the upper, lower and capitalised forms. Wildcards are kept.
 */
function valueVariants(c: Column, segments: Segment[]): Segment[][] {
  const text = literalText(segments);
  const alias = !isWildcard(segments) ? c.valueAliases?.[text.toLowerCase()] : undefined;
  const base: Segment[] = alias !== undefined ? [{ lit: alias }] : segments;
  if (!c.caseInsensitive) return [base];
  // Fixed order (upper, lower, capitalised, then the typed form if it is none of them).
  const forms = [(x: string) => x.toUpperCase(), (x: string) => x.toLowerCase(), capitalise, (x: string) => x];
  const out = new Map<string, Segment[]>();
  for (const f of forms) {
    // Capitalise only the first literal piece; later pieces of a wildcard term are lower-cased.
    const v = base.map((seg, i) => ('lit' in seg ? { lit: f === capitalise && i > 0 ? seg.lit.toLowerCase() : f(seg.lit) } : seg));
    out.set(literalText(v), v);
  }
  return [...out.values()];
}

function datetimeLiteral(v: string, field: string): string {
  if (!DATETIME_RE.test(v)) throw new CompileError(`'${v}' is not a date or time (field ${field})`);
  return sqlString(v.replace('T', ' '));
}

// ---------------------------------------------------------------- field resolution

function columnByName(source: Source, name: string): Column | undefined {
  return source.columns.find((c) => c.name === name);
}

function resolve(source: Source, field: string | null): Target[] {
  if (field === null) {
    return source.defaultFields.map((name) => {
      const column = columnByName(source, name);
      if (!column) throw new CompileError(`default field ${name} is not a column of ${source.table}`);
      return { column, path: null };
    });
  }
  const aliased = source.aliases[field] ?? field;
  const exact = columnByName(source, aliased);
  if (exact) return [{ column: exact, path: null }];
  for (const c of source.columns) {
    if (c.type === 'variant' && aliased.startsWith(`${c.name}.`)) {
      return [{ column: c, path: aliased.slice(c.name.length + 1) }];
    }
  }
  if (source.attributeColumns.length === 0) throw new CompileError(`unknown field '${field}'`);
  return source.attributeColumns.map((name) => {
    const column = columnByName(source, name);
    if (!column || column.type !== 'variant') {
      throw new CompileError(`attribute column ${name} is not a VARIANT column of ${source.table}`);
    }
    return { column, path: aliased };
  });
}

function dslField(t: Target): string {
  return t.path === null ? t.column.name : `${t.column.name}.${t.path}`;
}

/** SQL expression for a target; variant paths are read as `type`. */
function sqlExpr(t: Target, as: 'STRING' | 'DOUBLE'): string {
  return t.path === null ? t.column.name : `CAST(${t.column.name}[${sqlString(t.path)}] AS ${as})`;
}

function label(t: Target): string {
  return dslField(t);
}

// ---------------------------------------------------------------- leaves

function compileTerm(t: Target, segments: Segment[]): Frag {
  const c = t.column;
  if (t.path === null && c.type === 'number') {
    if (isWildcard(segments)) throw new CompileError(`wildcards are not allowed on number field ${c.name}`);
    return { sql: `${c.name} = ${columnNumber(c, literalText(segments))}` };
  }
  if (t.path === null && c.type === 'datetime') {
    if (isWildcard(segments)) throw new CompileError(`wildcards are not allowed on time field ${c.name}`);
    return { sql: `${c.name} = ${datetimeLiteral(literalText(segments), c.name)}` };
  }
  if (c.index !== 'none') {
    const terms = valueVariants(c, segments).map((v) => `${dslField(t)}:${dslTerm(v)}`);
    return { dsl: terms.length === 1 ? terms[0]! : `(${terms.join(' OR ')})` };
  }
  const expr = sqlExpr(t, 'STRING');
  return isWildcard(segments)
    ? { sql: `${expr} LIKE ${sqlString(likePattern(segments))}` }
    : { sql: `${expr} = ${sqlString(literalText(segments))}` };
}

function compilePhrase(t: Target, text: string): Frag {
  const c = t.column;
  if (t.path === null && (c.type === 'number' || c.type === 'datetime')) {
    return compileTerm(t, [{ lit: text }]);
  }
  if (c.index === 'fulltext') return { dsl: `${dslField(t)}:${dslPhrase(text)}` };
  // An untokenized index holds whole values, so a quoted value is one exact term.
  if (c.index === 'keyword') return compileTerm(t, [{ lit: text }]);
  return { sql: `${sqlExpr(t, 'STRING')} LIKE ${sqlString(`%${likePattern([{ lit: text }])}%`)}` };
}

function compileRegex(t: Target, pattern: string): Frag {
  const c = t.column;
  if (t.path === null && (c.type === 'number' || c.type === 'datetime')) {
    throw new CompileError(`regular expressions are not allowed on field ${c.name}`);
  }
  if (c.index !== 'none') return { dsl: `${dslField(t)}:${dslRegex(pattern)}` };
  return { sql: `${sqlExpr(t, 'STRING')} REGEXP ${sqlString(pattern)}` };
}

function compileRange(t: Target, n: Extract<Node, { kind: 'range' }>): Frag {
  const bounds = [n.lo, n.hi].filter((b): b is string => b !== null);
  if (bounds.length === 0) return compileExists(t);
  let expr: string;
  let lit: (v: string) => string;
  if (t.path === null && t.column.type === 'number') {
    expr = t.column.name;
    lit = (v) => columnNumber(t.column, v);
  } else if (t.path === null && t.column.type === 'datetime') {
    expr = t.column.name;
    lit = (v) => datetimeLiteral(v, t.column.name);
  } else if (t.path !== null && bounds.every((b) => NUMBER_RE.test(b))) {
    expr = sqlExpr(t, 'DOUBLE');
    lit = (v) => v;
  } else {
    expr = sqlExpr(t, 'STRING');
    lit = sqlString;
  }
  const parts: string[] = [];
  if (n.lo !== null) parts.push(`${expr} ${n.loInclusive ? '>=' : '>'} ${lit(n.lo)}`);
  if (n.hi !== null) parts.push(`${expr} ${n.hiInclusive ? '<=' : '<'} ${lit(n.hi)}`);
  return { sql: parts.join(' AND ') };
}

function compileExists(t: Target): Frag {
  return { sql: `${t.path === null ? t.column.name : `${t.column.name}[${sqlString(t.path)}]`} IS NOT NULL` };
}

function leaf(source: Source, n: Exclude<Node, { kind: 'and' | 'or' | 'not' }>): Frag {
  const targets = resolve(source, n.field);
  // A pasted trace or span id is searched in its id column too.
  if (n.field === null && n.kind === 'term' && !isWildcard(n.segments)) {
    const text = literalText(n.segments);
    for (const id of source.idColumns ?? []) {
      const column = columnByName(source, id.column);
      if (column && id.pattern.test(text)) {
        return combine('OR', compileTargets(n, targets), compileTerm({ column, path: null }, [{ lit: text.toLowerCase() }]));
      }
    }
  }
  return compileTargets(n, targets);
}

function compileTargets(n: Exclude<Node, { kind: 'and' | 'or' | 'not' }>, targets: Target[]): Frag {
  const frags = targets.map((t) => {
    try {
      switch (n.kind) {
        case 'term': return compileTerm(t, n.segments);
        case 'phrase': return compilePhrase(t, n.text);
        case 'regex': return compileRegex(t, n.pattern);
        case 'range': return compileRange(t, n);
        case 'exists': return compileExists(t);
      }
    } catch (e) {
      if (e instanceof CompileError && targets.length > 1) return null; // e.g. a number in one of several columns
      throw e;
    }
  });
  const ok = frags.filter((f): f is Frag => f !== null);
  if (ok.length === 0) throw new CompileError(`no field of ${targets.map(label).join(', ')} accepts this value`);
  return ok.reduce((a, b) => combine('OR', a, b));
}

/**
 * A SQL expression reading a search bar field as a string, for grouping and top values.
 * A field found in several attribute columns reads the first one that has it.
 */
export function fieldExpr(source: Source, field: string): string {
  const exprs = resolve(source, field).map((t) => sqlExpr(t, 'STRING'));
  return exprs.length === 1 ? exprs[0]! : `coalesce(${exprs.join(', ')})`;
}

/**
 * A SQL expression reading a field as a number, for aggregates: number columns as they are,
 * attribute paths cast to DOUBLE. Text columns cannot be aggregated numerically.
 */
export function numericFieldExpr(source: Source, field: string): string {
  const exprs = resolve(source, field).map((t) => {
    if (t.path !== null) return sqlExpr(t, 'DOUBLE');
    if (t.column.type !== 'number') throw new CompileError(`'${field}' is not a number field`);
    return t.column.name;
  });
  return exprs.length === 1 ? exprs[0]! : `coalesce(${exprs.join(', ')})`;
}

// ---------------------------------------------------------------- combination

function toSql(f: Frag): string {
  return 'sql' in f ? f.sql : `search(${sqlString(f.dsl)})`;
}

function combine(op: 'AND' | 'OR', a: Frag, b: Frag): Frag {
  if ('dsl' in a && 'dsl' in b) return { dsl: `(${a.dsl} ${op} ${b.dsl})` };
  return { sql: `(${toSql(a)} ${op} ${toSql(b)})` };
}

function compileNode(source: Source, n: Node): Frag {
  switch (n.kind) {
    case 'and': return combine('AND', compileNode(source, n.left), compileNode(source, n.right));
    case 'or': return combine('OR', compileNode(source, n.left), compileNode(source, n.right));
    case 'not': {
      const c = compileNode(source, n.child);
      // A row whose field is NULL (attribute absent) does not match the inner predicate,
      // so it matches the negation; plain SQL NOT would drop it as unknown.
      return 'dsl' in c ? { dsl: `NOT ${c.dsl}` } : { sql: `NOT coalesce(${c.sql}, false)` };
    }
    default: return leaf(source, n);
  }
}

/** Compile a search bar query to a SQL boolean expression over `source.table`. */
export function compileWhere(source: Source, query: string): string {
  const ast = parseQuery(query);
  return ast === null ? 'TRUE' : toSql(compileNode(source, ast));
}

// ---------------------------------------------------------------- unknown fields

function fieldsOf(n: Node, out: Set<string>): Set<string> {
  if (n.kind === 'and' || n.kind === 'or') {
    fieldsOf(n.left, out);
    fieldsOf(n.right, out);
  } else if (n.kind === 'not') {
    fieldsOf(n.child, out);
  } else if (n.field !== null) {
    out.add(n.field);
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

export interface UnknownField {
  field: string;
  /** The closest known field, when one is close enough to be a likely typo. */
  suggestion: string | null;
}

/**
 * Fields of the query that are neither columns, aliases nor attribute paths seen in the data
 * (`known`, as /api/fields lists them). They compile, but match nothing; the UI warns.
 */
export function unknownFields(source: Source, query: string, known: string[]): UnknownField[] {
  const ast = parseQuery(query);
  if (ast === null) return [];
  const knownSet = new Set(known);
  const out: UnknownField[] = [];
  for (const field of fieldsOf(ast, new Set())) {
    const name = source.aliases[field] ?? field;
    if (knownSet.has(field) || columnByName(source, name)) continue;
    const variant = source.columns.find((c) => c.type === 'variant' && name.startsWith(`${c.name}.`));
    const path = variant ? name.slice(variant.name.length + 1) : null;
    if (path !== null && (knownSet.has(path) || knownSet.has(name))) continue;
    let best: string | null = null;
    let bestD = Infinity;
    for (const k of [...knownSet, ...Object.keys(source.aliases)]) {
      const dist = editDistance(field.toLowerCase(), k.toLowerCase());
      if (dist < bestD) [best, bestD] = [k, dist];
    }
    out.push({ field, suggestion: bestD <= Math.max(1, Math.floor(field.length / 4)) ? best : null });
  }
  return out;
}
