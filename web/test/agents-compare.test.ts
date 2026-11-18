// The comparison of two sessions without a browser: its rows, each side's lane, and the differences in facts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepFacts, TurnPair } from '../src/api/agents.ts';
import { type Cell, delta, FACTS, planRows, sideLane, toolsLabel } from '../src/lib/agents/compare.ts';
import type { Turn } from '../src/lib/agents/lanes.ts';

const turnOf = (no: number, steps: number, extra: Partial<Turn> = {}): Turn => ({
  sid: 's', no, userInput: `ask ${no}`, steps, failedCalls: 0, compactions: 0, activeUs: 0, ctxFirst: 1000, ctxLast: 4000, tools: '', firstStep: 1, lastCall: 9,
  exact: true, startedAt: null, ...extra,
});
const fact = (seq: number, tools: string, ctx: number, failed = false): StepFacts => ({ seq, step: seq, tools, targets: '', failed, ctx });
const kinds = (rows: ReturnType<typeof planRows>) => rows.map((r) => `${r.kind}${r.differs ? '*' : ''}:${r.left?.type ?? '-'}/${r.right?.type ?? '-'}`);

test('the rows of a comparison: turns paired by number, a turn only one session has differs', () => {
  const view = { pairs: new Map<number, TurnPair>(), open: new Set<number>(), shown: new Map<number, number>() };
  assert.deepEqual(kinds(planRows([turnOf(1, 2), turnOf(2, 1)], [turnOf(1, 3)], view)), ['closed:turn/turn', 'closed*:turn/-']);
  // An open pair that is still being read says so on the sides that have the turn.
  assert.deepEqual(kinds(planRows([turnOf(1, 2), turnOf(2, 1)], [turnOf(1, 3)], { ...view, open: new Set([1, 2]) })),
    ['turn:turn/turn', 'more:more/more', 'turn*:turn/-', 'more:more/-']);
});

test('an open pair of turns: the paired steps, a compaction after the step it follows, the rest on request', () => {
  const pair: TurnPair = {
    a: [fact(2, 'Read', 2000), fact(5, 'Bash', 3000, true)], b: [fact(2, 'Read', 2500), fact(4, 'Edit', 2600), fact(6, 'Bash', 2700)],
    rows: [{ a: 0, b: 0, differs: false }, { a: null, b: 1, differs: true }, { a: 1, b: 2, differs: true }],
    cuts: { a: [{ seq: 1, after: -1 }, { seq: 3, after: 0 }], b: [{ seq: 3, after: 0 }] },
  };
  const view = { pairs: new Map([[1, pair]]), open: new Set([1]), shown: new Map<number, number>() };
  const rows = planRows([turnOf(1, 2)], [turnOf(1, 3)], view);
  assert.deepEqual(kinds(rows), ['turn:turn/turn', 'cut*:cut/-', 'step:step/step', 'cut:cut/cut', 'step*:-/step', 'step*:step/step']);
  const some = planRows([turnOf(1, 2)], [turnOf(1, 3)], { ...view, shown: new Map([[1, 1]]) });
  assert.deepEqual(kinds(some), ['turn:turn/turn', 'cut*:cut/-', 'step:step/step', 'cut:cut/cut', 'more:more/more']);
  assert.equal(some[some.length - 1]!.rest, 2);
});

test('one side as a lane: it widens with each step, narrows at a compaction, and passes by where the side is empty', () => {
  const cells: Cell[] = [
    { type: 'turn', turn: turnOf(1, 2), open: true }, { type: 'step', step: fact(2, 'Read', 2000) }, null, { type: 'cut', seq: 3 },
    { type: 'step', step: fact(5, 'Bash', 500) }, null,
  ];
  const lane = sideLane(cells, 1000);
  assert.deepEqual(lane.map((r) => [r.from, r.at, r.to]), [[1000, 1000, 1000], [1000, 2000, 2000], [2000, 2000, 2000], [2000, 2000, 500], [500, 500, 500], [500, 500, 500]]);
  assert.deepEqual(lane.map((r) => r.pass), [null, null, 2000, null, null, null]);
  assert.deepEqual(lane.map((r) => [r.above, r.below]), [[false, true], [true, true], [true, true], [true, true], [true, false], [true, false]]);
  // A closed turn carries the lane to the size its last request had; an empty side before the first row draws nothing.
  const closed = sideLane([null, { type: 'turn', turn: turnOf(1, 2), open: false }], 1000);
  assert.deepEqual(closed.map((r) => [r.to, r.pass]), [[1000, null], [4000, null]]);
});

test('how session B differs from session A, written like the values above it', () => {
  const a = { model: 'opus', started_at: '2026-11-17 10:00:00.000000', turns: 2, steps: '7', tool_errors: 1, active_us: '70000000', input_tokens: '70', output_tokens: '140', peak_ctx_tokens: '115000' };
  const b = { ...a, model: 'fable', steps: '5', tool_errors: 0, active_us: '73500000', peak_ctx_tokens: '127000' };
  const by = (label: string) => delta(FACTS.find((f) => f.label === label)!, a, b);
  assert.deepEqual(['Model', 'Started', 'Turns', 'Steps', 'Errors', 'Active time', 'Tokens', 'Peak context'].map(by), ['differs', '', '0', '−2', '−1', '+3.5s', '0', '+12k tok']);
  assert.equal(delta(FACTS[0]!, a, a), 'same');
  assert.equal(toolsLabel('Bash Bash Read Bash'), 'Bash ×2 Read Bash');
  assert.equal(toolsLabel('reply'), 'reply');
});
