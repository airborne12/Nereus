// The comparison of two sessions: their facts in one table, and their lanes side by side. Turns are
// paired by number; the steps of an open pair of turns arrive paired from the API. This module lays
// the rows out and works out each side's lane.

import type { Row, StepFacts, TurnPair } from '../../api/agents.ts';
import { duration, num, stamp, text, timeOf, tokens } from './format.ts';
import type { RowKind } from './lane-draw.ts';
import type { Turn } from './lanes.ts';

/** An open pair of turns shows this many rows at first; the rest come a hundred at a time. */
export const PAIRS_PAGE = 100;

/** What one side shows on a row; null leaves that side empty. */
export type Cell =
  | { type: 'turn'; turn: Turn; open: boolean }
  | { type: 'step'; step: StepFacts }
  | { type: 'cut'; seq: number }
  | { type: 'more' }
  | null;

export interface PlanRow {
  kind: RowKind;
  /** The number of the pair of turns the row belongs to. */
  no: number;
  /** Tinted: one side is empty, or the tool or the outcome differ. */
  differs: boolean;
  left: Cell;
  right: Cell;
  /** On a `more` row: pairs not shown yet; 0 while the pair of turns is being read. */
  rest: number;
}

export interface CompareView {
  /** The steps of the pairs of turns read so far, by turn number. */
  pairs: ReadonlyMap<number, TurnPair>;
  /** The open pairs of turns. */
  open: ReadonlySet<number>;
  /** How many rows of an open pair are shown, when more than the first page. */
  shown: ReadonlyMap<number, number>;
}

const cutRows = (no: number, left: number[], right: number[]): PlanRow[] =>
  Array.from({ length: Math.max(left.length, right.length) }, (_, i): PlanRow => ({
    kind: 'cut', no, differs: left[i] === undefined || right[i] === undefined, rest: 0,
    left: left[i] === undefined ? null : { type: 'cut', seq: left[i]! }, right: right[i] === undefined ? null : { type: 'cut', seq: right[i]! },
  }));

/** The rows of the comparison in order. */
export function planRows(a: readonly Turn[], b: readonly Turn[], view: CompareView): PlanRow[] {
  const numbers = [...new Set([...a, ...b].map((t) => t.no))].sort((x, y) => x - y);
  return numbers.flatMap((no): PlanRow[] => {
    const l = a.find((t) => t.no === no) ?? null;
    const r = b.find((t) => t.no === no) ?? null;
    const open = view.open.has(no);
    const head: PlanRow = {
      kind: open ? 'turn' : 'closed', no, differs: !l || !r, rest: 0,
      left: l && { type: 'turn', turn: l, open }, right: r && { type: 'turn', turn: r, open },
    };
    if (!open) return [head];
    const pair = view.pairs.get(no);
    if (!pair) return [head, { kind: 'more', no, differs: false, rest: 0, left: l && { type: 'more' }, right: r && { type: 'more' } }];
    const after = (side: 'a' | 'b', at: number | null) => pair.cuts[side].filter((c) => at !== null && c.after === at).map((c) => c.seq);
    const shown = pair.rows.slice(0, view.shown.get(no) ?? PAIRS_PAGE);
    const body = shown.flatMap((p): PlanRow[] => [
      {
        kind: 'step', no, differs: p.differs, rest: 0,
        left: p.a === null ? null : { type: 'step', step: pair.a[p.a]! }, right: p.b === null ? null : { type: 'step', step: pair.b[p.b]! },
      },
      ...cutRows(no, after('a', p.a), after('b', p.b)),
    ]);
    const hidden = pair.rows.slice(shown.length);
    const more: PlanRow[] = hidden.length === 0 ? [] : [{
      kind: 'more', no, differs: false, rest: hidden.length,
      left: hidden.some((p) => p.a !== null) ? { type: 'more' } : null, right: hidden.some((p) => p.b !== null) ? { type: 'more' } : null,
    }];
    return [head, ...cutRows(no, after('a', -1), after('b', -1)), ...body, ...more];
  });
}

/** One side of a row with its lane: the context size at the top edge, at the node and at the bottom edge. */
export interface SideRow {
  cell: Cell;
  from: number;
  at: number;
  to: number;
  above: boolean;
  below: boolean;
  /** For an empty side: the context size of the lane passing through, or null when it has not begun or has ended. */
  pass: number | null;
}

/** One side of the comparison as the rows of one lane. Where the side shows nothing, its lane passes straight through. */
export function sideLane(cells: readonly Cell[], start: number): SideRow[] {
  const drafts = cells.reduce<{ tok: number; seen: boolean; rows: Omit<SideRow, 'below'>[] }>((acc, cell, i) => {
    const from = acc.tok;
    if (!cell) return { ...acc, rows: [...acc.rows, { cell, from, at: from, to: from, above: acc.seen, pass: acc.seen ? from : null }] };
    // A compaction narrows the lane to the size of the next step on this side.
    const next = cells.slice(i + 1).find((c) => c?.type === 'step' || c?.type === 'turn');
    const ahead = next?.type === 'step' ? next.step.ctx : next?.type === 'turn' ? next.turn.ctxFirst : from;
    const to = cell.type === 'step' ? cell.step.ctx : cell.type === 'cut' ? ahead
      : cell.type === 'turn' ? (cell.open || cell.turn.steps === 0 ? from : cell.turn.ctxLast) : from;
    return { tok: to, seen: true, rows: [...acc.rows, { cell, from, at: cell.type === 'step' ? to : from, to, above: acc.seen, pass: null }] };
  }, { tok: start, seen: false, rows: [] }).rows;
  // A lane is drawn through a row only while a later row still belongs to it.
  return drafts.reduceRight<{ alive: boolean; rows: SideRow[] }>((acc, r) => ({
    alive: acc.alive || r.cell !== null,
    rows: [{ ...r, below: acc.alive, pass: r.cell === null && acc.alive ? r.pass : null }, ...acc.rows],
  }), { alive: false, rows: [] }).rows;
}

/** The tools of a step as Compare names them: equal neighbours are counted, `Bash ×2 Read`. */
export function toolsLabel(tools: string): string {
  return tools.split(' ').filter(Boolean).reduce<{ name: string; n: number }[]>((acc, name) => {
    const last = acc[acc.length - 1];
    return last && last.name === name ? [...acc.slice(0, -1), { name, n: last.n + 1 }] : [...acc, { name, n: 1 }];
  }, []).map((t) => (t.n > 1 ? `${t.name} ×${t.n}` : t.name)).join(' ');
}

/** A fact the comparison lists: its label, its value, how it is written, and how a difference is written. */
interface Fact { label: string; value: (s: Row) => number | string; show: (v: number | string) => string; kind: 'number' | 'text' | 'none' }

const count = (v: number | string): string => String(v);
export const FACTS: readonly Fact[] = [
  { label: 'Model', value: (s) => text(s.model), show: String, kind: 'text' },
  { label: 'Started', value: (s) => timeOf(s.started_at) ?? 0, show: (v) => (v ? stamp(Number(v)) : ''), kind: 'none' },
  { label: 'Turns', value: (s) => num(s.turns), show: count, kind: 'number' },
  { label: 'Steps', value: (s) => num(s.steps), show: count, kind: 'number' },
  { label: 'Errors', value: (s) => num(s.tool_errors), show: count, kind: 'number' },
  { label: 'Sub-agents', value: (s) => num(s.subagents), show: count, kind: 'number' },
  { label: 'Compactions', value: (s) => num(s.compactions), show: count, kind: 'number' },
  { label: 'Active time', value: (s) => num(s.active_us), show: (v) => duration(Number(v)), kind: 'number' },
  { label: 'Tokens', value: (s) => num(s.input_tokens) + num(s.output_tokens), show: (v) => tokens(Number(v)), kind: 'number' },
  { label: 'Peak context', value: (s) => num(s.peak_ctx_tokens), show: (v) => `${tokens(Number(v))} tok`, kind: 'number' },
];

/** How session B differs from session A in one fact: `+12`, `−3.5s`, `same`, `differs`; empty where a difference says nothing. */
export function delta(f: Fact, a: Row, b: Row): string {
  if (f.kind === 'none') return '';
  const x = f.value(a);
  const y = f.value(b);
  if (f.kind === 'text') return x === y ? 'same' : 'differs';
  if (x === y) return '0';
  // The size of a difference is written like the values above it.
  return `${Number(y) > Number(x) ? '+' : '−'}${f.show(Math.abs(Number(y) - Number(x)))}`;
}
