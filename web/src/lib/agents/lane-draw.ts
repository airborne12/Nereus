// How a row of the lanes is drawn: its height, where its node sits, the shape of its lane, and
// which rows of a long list a window touches.

import type { LaneRow } from './lanes.ts';

export const X0 = 20;
export const LANE = 20;
/** Room to the right of a node for a branch, before the text of the row starts. */
const TEXT = 28;
export type RowKind = 'turn' | 'closed' | 'step' | 'branch' | 'cut' | 'more';
export const HEIGHT: Record<RowKind, number> = { turn: 36, closed: 54, step: 28, branch: 28, cut: 34, more: 28 };
export const NODE_Y: Record<RowKind, number> = { turn: 18, closed: 18, step: 14, branch: 14, cut: 17, more: 14 };

/** A turn that is not open takes a taller row, for the chain of its steps. */
export const kindOf = (r: { type: LaneRow['type']; open?: boolean }): RowKind => (r.type === 'turn' && !r.open ? 'closed' : r.type);
export const laneX = (lane: number): number => X0 + LANE * lane;
/** Where the text of a row starts, to the right of its lane. */
export const indent = (lane: number): number => laneX(lane) + TEXT;
/** Half the width of a lane for a context of this many tokens. */
export const half = (tok: number, scale: number): number => Math.max(1, Math.min(8, (8 * tok) / scale));
const n1 = (v: number): number => Number(v.toFixed(1));

/**
 * The lane of a row between its top and bottom edge, as the path of a filled shape. A compaction
 * narrows the lane as a funnel. A row that only says more steps follow has no shape (null).
 */
export function bandPath(r: { kind: RowKind; lane: number; from: number; at: number; to: number; above: boolean; below: boolean }, scale: number): string | null {
  const kind = r.kind;
  if (kind === 'more') return null;
  const h = HEIGHT[kind];
  const cy = NODE_Y[kind];
  const cx = laneX(r.lane);
  const a = n1(half(r.from, scale));
  const b = n1(half(r.at, scale));
  const c = n1(half(r.to, scale));
  if (kind === 'cut') {
    const y1 = cy - 9;
    const y2 = cy + 9;
    return `M${cx - a},0V${y1}C${cx - a},${cy} ${cx - c},${cy} ${cx - c},${y2}V${h}H${cx + c}V${y2}C${cx + c},${cy} ${cx + a},${cy} ${cx + a},${y1}V0Z`;
  }
  // A closed turn that ends the session still shows a short tail for the steps inside it.
  const end = r.below ? h : kind === 'closed' ? h - 10 : cy;
  const top = r.above ? `M${cx - a},0L${cx - b},${cy}` : `M${cx - b},${cy}`;
  const back = r.above ? `L${cx + b},${cy}L${cx + a},0Z` : `L${cx + b},${cy}Z`;
  return `${top}${end > cy ? `L${cx - c},${end}L${cx + c},${end}` : ''}${back}`;
}

/** The top of each row of the list; the last entry is the height of the whole list. */
export function rowTops(rows: readonly LaneRow[]): number[] {
  // Filled in one pass: a copy per row would cost the square of the list's length.
  const tops = new Array<number>(rows.length + 1);
  tops[0] = 0;
  for (let i = 0; i < rows.length; i += 1) tops[i + 1] = tops[i]! + HEIGHT[kindOf(rows[i]!)];
  return tops;
}

/** The rows [start, end) that a window of the list touches, with a margin above and below it. */
export function windowOf(tops: readonly number[], top: number, height: number, margin: number): [number, number] {
  const n = tops.length - 1;
  // The first index in [from, n] for which `past` holds; rows are in order, so it is found by halving.
  const first = (from: number, past: (i: number) => boolean): number => {
    let lo = from;
    let hi = n;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (past(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const start = first(0, (i) => tops[i + 1]! > top - margin);
  return [start, first(start, (i) => tops[i]! >= top + height + margin)];
}
