// A sequence pattern compiled to SQL (spec 7 and 8.5). The events of each session are numbered in
// order; every step of the pattern is one more level. Every event that meets step 1 starts at most
// one match, and each further step takes the nearest event that meets it: the very next one, or
// any later one.

import { CompileError, sqlString } from '../search/compile.ts';
import { MAX_LIMIT, type Statement, timeRange } from '../trajectory/query.ts';
import { EVENT_KIND, eventsCtes } from './events.ts';
import type { Step, StepKind } from './pattern.ts';

export interface MatchRequest {
  from: string;
  to: string;
  pattern: Step[];
  /** `time`, `session`, `agent`, `turn`, `span`, or `step<n>` for the time of a step. */
  sort?: string;
  dir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** One event of a match. `call` is the model call that issued a tool call. */
export interface MatchStep {
  kind: StepKind;
  seq: number;
  call: number | null;
  ts: string;
  turn: number;
  step: number;
  what: string;
  status: string;
  target: string;
}

export interface Match {
  session_id: string;
  root_id: string;
  title: string | null;
  agent: string;
  ts: string;
  turn: number;
  /** Events from the first step of the match to the last. */
  span: number;
  steps: MatchStep[];
}

/** Characters of a target the table of matches carries. */
export const TARGET_CHARS = 200;

const STEP_KIND = new Map(Object.entries(EVENT_KIND).map(([kind, event]) => [event, kind as StepKind]));
const AFTER = 'OVER (PARTITION BY b.session_id ORDER BY b.pos ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)';

/** The conditions an event `c` meets to be taken by a step; `m` is the match so far. */
function meets(step: Step, c: string): string[] {
  return [
    `${c}.kind = ${sqlString(EVENT_KIND[step.kind])}`,
    ...(step.tool ? [`${c}.what = ${sqlString(step.tool)}`] : []),
    ...(step.status ? [`${c}.status = ${sqlString(step.status === 'failed' ? 'error' : 'ok')}`] : []),
    ...(step.has ? [`instr(lower(${c}.target), ${sqlString(step.has)}) > 0`] : []),
    ...(step.any ? [`(${step.any.map((w) => `instr(lower(${c}.target), ${sqlString(w)}) > 0`).join(' OR ')})`] : []),
    ...(step.same ? [`${c}.target = m.res${step.same}`, `${c}.target <> ''`] : []),
  ];
}

/** A later step that is not compared with an earlier one depends on position alone, so a window finds it. */
const byWindow = (step: Step): boolean => step.link === 'later' && !step.same;

/** The levels m1 … mk: each holds the positions of the steps so far and the targets still to be compared with. */
function levels(pattern: readonly Step[]): string[] {
  const kept = [...new Set(pattern.flatMap((s) => (s.same ? [s.same] : [])))].sort((a, b) => a - b);
  // What a level takes from its own event: the target later steps compare with, and where the next step is.
  // min_by passes over NULL. That is right for `n`: where the nearest event has none, no later one has either.
  const taken = (j: number, c: string, grouped: boolean): string[] => [
    ...(kept.includes(j) ? [grouped ? `min_by(${c}.target, ${c}.pos) AS res${j}` : `${c}.target AS res${j}`] : []),
    ...(pattern[j] && byWindow(pattern[j]!) ? [grouped ? `min_by(${c}.n${j + 1}, ${c}.pos) AS nx${j + 1}` : `${c}.n${j + 1} AS nx${j + 1}`] : []),
  ];
  const first = `m1 AS (\n  SELECT ${['a.session_id', 'a.pos AS pos1', ...taken(1, 'a', false)].join(', ')}\n  FROM events a\n  WHERE ${meets(pattern[0]!, 'a').join(' AND ')}\n)`;
  const rest = pattern.slice(1).map((step, n) => {
    const j = n + 2;
    const held = ['m.session_id', ...Array.from({ length: j - 1 }, (_, i) => `m.pos${i + 1}`), ...kept.filter((q) => q < j).map((q) => `m.res${q}`)];
    const from = `  FROM m${j - 1} m\n  JOIN events c ON c.session_id = m.session_id AND c.pos`;
    if (byWindow(step)) return `m${j} AS (\n  SELECT ${[...held, `c.pos AS pos${j}`, ...taken(j, 'c', false)].join(', ')}\n${from} = m.nx${j}\n)`;
    const where = `\n  WHERE ${meets(step, 'c').join(' AND ')}`;
    if (step.link === 'next') return `m${j} AS (\n  SELECT ${[...held, `c.pos AS pos${j}`, ...taken(j, 'c', false)].join(', ')}\n${from} = m.pos${j - 1} + 1${where}\n)`;
    return `m${j} AS (\n  SELECT ${[...held, `min(c.pos) AS pos${j}`, ...taken(j, 'c', true)].join(', ')}\n${from} > m.pos${j - 1}${where}\n  GROUP BY ${held.join(', ')}\n)`;
  });
  return [first, ...rest];
}

/** What the table is sorted by: an expression over the match `m`, its session `s` and the event `o` of step `step`. */
function sortOf(req: MatchRequest): { by: string; step: number; dir: 'ASC' | 'DESC' } {
  const k = req.pattern.length;
  const name = req.sort ?? 'time';
  const fixed: Record<string, string> = { time: 'o.ts', session: 's.title', agent: 'coalesce(s.agent_name, s.kind)', turn: 'o.turn', span: `m.pos${k} - m.pos1 + 1` };
  const step = /^step([1-6])$/.exec(name);
  const by = Object.hasOwn(fixed, name) ? fixed[name]! : step && Number(step[1]) <= k ? 'o.ts' : null;
  if (!by) throw new CompileError(`unknown sort '${name}'; use ${[...Object.keys(fixed), ...Array.from({ length: k }, (_, i) => `step${i + 1}`)].join(', ')}`);
  const dir: string = req.dir ?? 'desc';
  if (dir !== 'asc' && dir !== 'desc') throw new CompileError(`sort direction must be asc or desc, not '${dir}'`);
  return { by, step: step ? Number(step[1]) : 1, dir: dir === 'asc' ? 'ASC' : 'DESC' };
}

/**
 * The statements of the table of matches and its total, and the reader of the table's rows.
 * The table statement takes one page of matches, then joins the events of those matches once: it
 * answers one row per event, which `matches` puts back together.
 */
export function matchSql(db: string, req: MatchRequest): { rows: Statement; total: Statement; matches: (rows: readonly Record<string, unknown>[]) => Match[] } {
  const p = req.pattern;
  const k = p.length;
  if (!Number.isSafeInteger(req.limit) || req.limit < 1 || req.limit > MAX_LIMIT) throw new CompileError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (!Number.isSafeInteger(req.offset) || req.offset < 0) throw new CompileError('offset must be an integer of 0 or more');
  const sort = sortOf(req);
  const range = timeRange(req.from, req.to);
  const text = p.some((s) => s.kind === 'user' || s.kind === 'reply');
  const windows = p.flatMap((s, i) => (i > 0 && byWindow(s) ? [`min(if(${meets(s, 'b').join(' AND ')}, b.pos, NULL)) ${AFTER} AS n${i + 1}`] : []));
  const events = windows.length
    ? [...eventsCtes(db, range, 'base', text ? 'text' : 'calls'), `events AS (\n  SELECT b.*,\n         ${windows.join(',\n         ')}\n  FROM base b\n)`]
    : eventsCtes(db, range, 'events', text ? 'text' : 'calls');
  const head = `WITH ${[...events, ...levels(p)].join(',\n')}`;
  const positions = Array.from({ length: k }, (_, i) => `pos${i + 1}`);
  const rows = [
    `${head},`,
    'page AS (',
    `  SELECT m.session_id, ${positions.map((x) => `m.${x}`).join(', ')}, s.root_id, s.title, coalesce(s.agent_name, s.kind) AS agent, m.pos${k} - m.pos1 + 1 AS span, ${sort.by} AS sort_at`,
    `  FROM m${k} m`,
    `  JOIN events o ON o.session_id = m.session_id AND o.pos = m.pos${sort.step}`,
    `  JOIN ${db}.agent_sessions s ON s.session_id = m.session_id`,
    `  ORDER BY sort_at ${sort.dir}, m.session_id, m.pos1`,
    `  LIMIT ${req.limit} OFFSET ${req.offset}`,
    '),',
    // One row per step of each match of the page, so the events are joined once whatever the plan.
    'picked AS (',
    '  SELECT p.session_id, p.pos1, p.root_id, p.title, p.agent, p.span, p.sort_at, t.j, t.pos',
    `  FROM page p LATERAL VIEW posexplode(array(${positions.map((x) => `p.${x}`).join(', ')})) t AS j, pos`,
    ')',
    'SELECT k.session_id, k.pos1, k.root_id, k.title, k.agent, k.span, k.j,',
    `       c.seq, c.parent_seq AS call_seq, c.ts, c.turn, c.step, c.kind, c.what, c.status, left(c.target, ${TARGET_CHARS}) AS target`,
    'FROM picked k',
    'JOIN events c ON c.session_id = k.session_id AND c.pos = k.pos',
    `ORDER BY k.sort_at ${sort.dir}, k.session_id, k.pos1, k.j`,
  ].join('\n');
  return {
    rows: { title: 'Matches', sql: rows },
    total: { title: 'Total', sql: `${head}\nSELECT count(*) AS matches, count(DISTINCT session_id) AS sessions\nFROM m${k}` },
    matches: (found) => readMatches(found, k),
  };
}

/** The matches of the table statement's rows: `k` rows per match, one per step, in order. */
function readMatches(rows: readonly Record<string, unknown>[], k: number): Match[] {
  return Array.from({ length: Math.ceil(rows.length / k) }, (_, i) => rows.slice(i * k, i * k + k)).map((group) => {
    const first = group[0]!;
    if (group.length !== k || group.some((r, j) => Number(r.j) !== j || r.session_id !== first.session_id || String(r.pos1) !== String(first.pos1))) throw new Error('the rows of a match are incomplete');
    const steps = group.map((r): MatchStep => ({
      kind: STEP_KIND.get(String(r.kind)) ?? 'call', seq: Number(r.seq), call: r.call_seq === null || r.call_seq === undefined ? null : Number(r.call_seq),
      ts: String(r.ts), turn: Number(r.turn), step: Number(r.step), what: String(r.what), status: String(r.status ?? ''), target: String(r.target ?? ''),
    }));
    return {
      session_id: String(first.session_id), root_id: String(first.root_id), title: (first.title as string | null) ?? null, agent: String(first.agent),
      ts: steps[0]!.ts, turn: steps[0]!.turn, span: Number(first.span), steps,
    };
  });
}
