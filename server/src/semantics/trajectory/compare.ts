// Compare (spec 8.4): two sessions' facts and turns from Doris, and the steps of one pair of turns
// paired in order here. Pairing is an alignment, not a set operation (spec 2, exception to rule 1).

import { CompileError, sqlString } from '../search/compile.ts';
import { CTX_TOKENS } from './pages.ts';
import type { Statement } from './query.ts';
import { sessionId, treeSqlFor, turnsSql } from './session.ts';

/** Two turns whose step counts multiply to more than this are paired by position. */
export const ALIGN_LIMIT = 4_000_000;

/** What a step did, as Compare pairs it; `ctx` is the size of its request in tokens, for the lane. */
export interface StepFacts { seq: number; step: number; tools: string; targets: string; failed: boolean; ctx: number }
/** A compaction of a turn: `after` is the index of the step it follows, -1 before the first. */
export interface CutFacts { seq: number; after: number }
/** One row of a pair of turns: an index into each side, or null where that side has no step. */
export interface PairRow { a: number | null; b: number | null; differs: boolean }

export function compareSql(db: string, a: string, b: string, turn: number | null): Statement[] {
  const ids = [sessionId(a), sessionId(b)];
  const list = ids.map(sqlString).join(', ');
  const head = [treeSqlFor(db, ids), turnsSql(db, ids)];
  if (turn === null) return head;
  if (!Number.isSafeInteger(turn) || turn < 0) throw new CompileError("'turn' must be a whole number from 0");
  return [...head, {
    title: `Steps of turn ${turn}`,
    sql: `SELECT e.session_id, e.seq, e.step, e.kind,
       coalesce(t.tools, 'reply') AS tools, coalesce(t.targets, '') AS targets, coalesce(t.failed, 0) AS failed,
       ${CTX_TOKENS} AS ctx_tokens
FROM ${db}.agent_events e
LEFT JOIN (
  SELECT session_id, parent_seq, group_concat(name, ' ' ORDER BY seq) AS tools,
         group_concat(coalesce(resource, cast(args['description'] AS STRING), ''), ' ' ORDER BY seq) AS targets,
         sum(if(status = 'error', 1, 0)) AS failed
  FROM ${db}.agent_events
  WHERE session_id IN (${list}) AND turn = ${turn} AND kind = 'tool_call'
  GROUP BY session_id, parent_seq
) t ON t.session_id = e.session_id AND t.parent_seq = e.seq
WHERE e.session_id IN (${list}) AND e.turn = ${turn} AND e.kind IN ('llm_call', 'compaction')
ORDER BY e.session_id, e.seq`,
  }];
}

/** The steps of one session in the rows of a pair of turns, and its compactions with the step each follows. */
export function turnSide(rows: readonly Record<string, unknown>[], id: string): { steps: StepFacts[]; cuts: CutFacts[] } {
  const mine = rows.filter((r) => r.session_id === id);
  const steps = mine.filter((r) => r.kind !== 'compaction').map((r) => ({
    seq: Number(r.seq), step: Number(r.step), tools: String(r.tools), targets: String(r.targets), failed: Number(r.failed) > 0, ctx: Number(r.ctx_tokens ?? 0),
  }));
  const cuts = mine.filter((r) => r.kind === 'compaction')
    .map((r) => ({ seq: Number(r.seq), after: steps.filter((s) => s.seq < Number(r.seq)).length - 1 }));
  return { steps, cuts };
}

/**
 * Index pairs (i, j), increasing in both, that maximise the sum of `score(i, j)` over the pairs;
 * a pair needs a positive score. Dynamic programming over suffixes, O(n * m).
 */
export function matches(n: number, m: number, score: (i: number, j: number) => number): [number, number][] {
  const w = m + 1;
  const best = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const s = score(i, j);
      best[i * w + j] = Math.max(s ? best[(i + 1) * w + j + 1]! + s : 0, best[(i + 1) * w + j]!, best[i * w + j + 1]!);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = score(i, j);
    if (s && best[i * w + j] === best[(i + 1) * w + j + 1]! + s) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (best[i * w + j] === best[(i + 1) * w + j]) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * Pairs the steps of two turns in order: steps with the same tools pair, the same calls first.
 * Steps left between two pairs share rows. A row differs when a side is empty or the tools or the
 * outcome differ.
 */
export function align(a: readonly StepFacts[], b: readonly StepFacts[]): PairRow[] {
  const score = (i: number, j: number) => (a[i]!.tools !== b[j]!.tools ? 0 : a[i]!.targets === b[j]!.targets ? 3 : 2);
  const row = (i: number | null, j: number | null): PairRow => {
    const x = i === null ? null : a[i]!;
    const y = j === null ? null : b[j]!;
    return { a: i, b: j, differs: !x || !y || x.tools !== y.tools || x.failed !== y.failed };
  };
  const stops: [number, number][] = [...(a.length * b.length > ALIGN_LIMIT ? [] : matches(a.length, b.length, score)), [a.length, b.length]];
  const rows: PairRow[] = [];
  let i = 0;
  let j = 0;
  for (const [si, sj] of stops) {
    for (let d = 0; d < Math.max(si - i, sj - j); d += 1) rows.push(row(i + d < si ? i + d : null, j + d < sj ? j + d : null));
    if (si < a.length) rows.push(row(si, sj));
    i = si + 1;
    j = sj + 1;
  }
  return rows;
}
