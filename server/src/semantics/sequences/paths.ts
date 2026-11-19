// "What happens next" (spec 7 and 8.5): from every event of one kind, the events that came next in
// its session, counted per path with lead(). Doris counts every branch and leaves out the ones the
// drawing never shows; the tree is put together here from those rows.

import { CompileError, sqlString } from '../search/compile.ts';
import { type Statement, timeRange } from '../trajectory/query.ts';
import { eventsCtes, rangeScope } from './events.ts';

/** Where a drawing starts: a failed call, a user input, or a call of one tool. */
export type Start = { kind: 'failed' } | { kind: 'user' } | { kind: 'tool'; tool: string };

export interface PathsRequest { from: string; to: string; start: Start; depth: number }

/** Columns of the drawing: the starting event and the events after it. */
export const MAX_DEPTH = 4;
/** Branches of a node drawn on their own; the rest are one "other". */
export const KIDS = 3;
/** A branch is drawn on its own only when it holds at least one run in this many. */
export const RARE = 50;
const MAX_TOOLS = 200;

/**
 * An event in one word: `c:<tool>` a tool call, `f:<tool>` a failed one, `u:` a user input, `r:` a
 * reply, `x:` a compaction. The empty key stands for "the session ends".
 */
const KEY = "concat(CASE kind WHEN 'tool_call' THEN if(status = 'error', 'f', 'c') WHEN 'user_input' THEN 'u' WHEN 'llm_call' THEN 'r' ELSE 'x' END, ':', if(kind = 'tool_call', what, ''))";

export function parseStart(raw: string | null): Start {
  if (raw === null || raw === '' || raw === 'failed') return { kind: 'failed' };
  if (raw === 'user') return { kind: 'user' };
  const tool = /^tool:(.{1,256})$/s.exec(raw)?.[1];
  if (!tool) throw new CompileError("'start' must be failed, user or tool:<name>");
  return { kind: 'tool', tool };
}

const startSql = (s: Start): string =>
  (s.kind === 'failed' ? "kind = 'tool_call' AND status = 'error'" : s.kind === 'user' ? "kind = 'user_input'" : `kind = 'tool_call' AND what = ${sqlString(s.tool)}`);

/** One level of the tree: its branches counted, ranked among the branches of their node. */
function levelSql(level: number, depth: number): string {
  const keys = Array.from({ length: level - 1 }, (_, i) => `k${i + 2}`);
  const parent = keys.slice(0, -1);
  const own = keys[keys.length - 1]!;
  const padded = Array.from({ length: depth - 1 }, (_, i) => (i < keys.length ? keys[i]! : `'' AS k${i + 2}`));
  const part = parent.length ? `PARTITION BY ${parent.join(', ')}` : '';
  // A run that ended at the level before has no branch here.
  const open = parent.length ? ` WHERE ${parent[parent.length - 1]} <> ''` : '';
  return [
    `  SELECT ${level} AS level, ${padded.join(', ')}, times,`,
    `         row_number() OVER (${[part, `ORDER BY times DESC, ${own}`].filter(Boolean).join(' ')}) AS rk, count(*) OVER (${part}) AS siblings, sum(times) OVER (${part}) AS parent_times`,
    `  FROM (SELECT ${keys.join(', ')}, count(*) AS times FROM runs${open} GROUP BY ${keys.join(', ')}) g`,
  ].join('\n');
}

/** The statement behind the drawing: the branches of each node that the drawing can show. */
export function pathsSql(db: string, req: PathsRequest): Statement {
  if (!Number.isInteger(req.depth) || req.depth < 2 || req.depth > MAX_DEPTH) throw new CompileError(`'depth' must be an integer from 2 to ${MAX_DEPTH}`);
  const range = timeRange(req.from, req.to);
  const after = Array.from({ length: req.depth - 1 }, (_, i) => i + 1);
  const keys = after.map((n) => `k${n + 1}`);
  const sql = [
    `WITH ${eventsCtes(db, rangeScope(range), 'events', 'none').join(',\n')},`,
    'runs AS (',
    `  SELECT ${keys.join(', ')}`,
    '  FROM (',
    `    SELECT kind, what, status, ${after.map((n) => `coalesce(lead(k, ${n}) OVER (PARTITION BY session_id ORDER BY pos), '') AS k${n + 1}`).join(',\n           ')}`,
    `    FROM (SELECT e.session_id, e.pos, e.kind, e.what, e.status, ${KEY} AS k FROM events e) e`,
    '  ) t',
    `  WHERE ${startSql(req.start)}`,
    '),',
    'ranked AS (',
    after.map((n) => levelSql(n + 1, req.depth)).join('\n  UNION ALL\n'),
    ')',
    `SELECT r.level, ${keys.map((k) => `r.${k}`).join(', ')}, r.times, r.rk, r.siblings, r.parent_times, t.n AS total`,
    'FROM ranked r',
    'CROSS JOIN (SELECT count(*) AS n FROM runs) t',
    // A node under one run in fifty is never drawn, so its branches are not needed; of a drawn node, the commonest ones are.
    `WHERE r.parent_times * ${RARE} >= t.n AND (r.rk = 1 OR (r.rk <= ${KIDS} AND r.times * ${RARE} >= t.n))`,
    `ORDER BY r.level, r.rk, ${keys.map((k) => `r.${k}`).join(', ')}`,
  ].join('\n');
  return { title: 'Paths', sql };
}

/** The tools called in the range, for the choices the page offers. */
export function toolsSql(db: string, from: string, to: string): Statement {
  const range = timeRange(from, to);
  return { title: 'Tools', sql: `SELECT name, count(*) AS calls\nFROM ${db}.agent_events\nWHERE kind = 'tool_call' AND ${range.cond('ts')}\nGROUP BY name\nORDER BY calls DESC, name\nLIMIT ${MAX_TOOLS}` };
}

export interface PathRow { level: number; k2: string; k3: string; k4: string; times: number; rk: number; siblings: number; parent_times: number; total: number }
/** The branches of a node that are not drawn on their own. */
export interface Other { count: number; times: number }
export interface PathNode { key: string; times: number; kids: PathNode[]; other: Other | null }
export interface PathTree { total: number; kids: PathNode[]; other: Other | null }

/** The tree of the drawing from the rows of the Paths statement, which arrive in the order of their rank. */
export function pathTree(rows: readonly PathRow[], depth: number): PathTree {
  const total = rows.length ? Number(rows[0]!.total) : 0;
  const keysOf = (r: PathRow): string[] => [r.k2, r.k3, r.k4].slice(0, Number(r.level) - 1);
  const under = (path: readonly string[], times: number): { kids: PathNode[]; other: Other | null } => {
    const level = path.length + 2;
    const branches = rows.filter((r) => Number(r.level) === level && path.every((k, i) => keysOf(r)[i] === k));
    const shown = branches.filter((r) => Number(r.rk) <= KIDS && Number(r.times) * RARE >= total);
    const kids = shown.map((r): PathNode => {
      const key = keysOf(r)[level - 2]!;
      const below = key !== '' && level < depth ? under([...path, key], Number(r.times)) : { kids: [], other: null };
      return { key, times: Number(r.times), ...below };
    });
    const rest = (branches.length ? Number(branches[0]!.siblings) : 0) - shown.length;
    return { kids, other: rest > 0 ? { count: rest, times: times - shown.reduce((n, r) => n + Number(r.times), 0) } : null };
  };
  return { total, ...under([], total) };
}
