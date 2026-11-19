// The lanes of the session page without a browser: the tree, the rows with their context sizes, the
// drawing of a row, and how a place of the tree is found and visited.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandPath, half, indent, kindOf, rowTops, windowOf } from '../src/lib/agents/lane-draw.ts';
import {
  branchKey, buildTree, chain, childrenOf, itemsKey, itemsOf, jumpTargets, laneRows, nextTarget, pagesToRead, reveal, rowKeyOf,
  stepFailed, stepLabel, stepRepeats, stepTotalUs, twistOf, type Item, type LaneRow, type Step, type Tree,
} from '../src/lib/agents/lanes.ts';

// A main session of two turns: turn 1 reads, fails a command, reads again, starts a sub-agent and
// answers; a compaction opens turn 2. Numbers arrive as the API sends them, big integers as text.
const session = (session_id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ session_id, root_id: 'm', parent_id: null, parent_seq: null, kind, agent_name: null, title: 'Fix the clock test', model: 'opus', peak_ctx_tokens: '9000', ...extra });
const turn = (session_id: string, n: number, extra: Record<string, unknown>) => ({
  session_id, turn: n, started_at: '2026-11-17 10:00:00.000000', user_input: `ask ${n}`, steps: '0', failed_calls: '0', compactions: '0', active_us: '0',
  ctx_first: '0', ctx_last: '0', tools: null, first_step: null, last_call: null, ctx_exact: null, ...extra,
});
const ev = (session_id: string, seq: number, kind: string, turnNo: number, step: number, extra: Record<string, unknown> = {}) => ({
  session_id, seq: String(seq), ts: '2026-11-17 10:00:01.000000', turn: turnNo, step, kind, parent_seq: null, name: null, resource: null, status: 'ok',
  duration_us: '1000000', ctx_tokens: '0', stop_reason: null, repeat_of: null, repeat_visible: null, ...extra,
});
const SESSIONS = [session('m', 'main'), session('a', 'subagent', { parent_id: 'm', parent_seq: '8', agent_name: 'Explore', title: 'look up clock helpers' })];
const TURNS = [
  turn('a', 1, { steps: '2', ctx_first: '1000', ctx_last: '1500', tools: 'Grep', first_step: 1, last_call: '4', ctx_exact: 0 }),
  turn('m', 1, { steps: '4', failed_calls: '1', ctx_first: '2000', ctx_last: '8000', tools: 'Read,Bash failed,Read,Agent', first_step: 1, last_call: '10', ctx_exact: 1 }),
  turn('m', 2, { steps: '1', compactions: '1', ctx_first: '3000', ctx_last: '3000', first_step: 5, last_call: '13', ctx_exact: 1 }),
];
const mark = (seq: number, kind: string, turnNo: number, step: number, extra: Record<string, unknown> = {}) =>
  ({ session_id: 'm', seq: String(seq), turn: turnNo, step, kind, parent_seq: null, failed: 0, repeated: 0, child: null, ...extra });
const MARKS = [
  mark(4, 'tool_call', 1, 1, { parent_seq: '2', failed: 1 }), mark(6, 'tool_call', 1, 2, { parent_seq: '5', repeated: 1 }),
  mark(8, 'tool_call', 1, 3, { parent_seq: '7', child: 'a' }), mark(12, 'compaction', 2, 4),
];
const M1 = [
  ev('m', 2, 'llm_call', 1, 1, { ctx_tokens: '2000', stop_reason: 'tool_use', duration_us: '2000000' }),
  ev('m', 3, 'tool_call', 1, 1, { parent_seq: '2', name: 'Read', resource: 'tests/clock_test.py' }),
  ev('m', 4, 'tool_call', 1, 1, { parent_seq: '2', name: 'Bash', resource: 'pytest', status: 'error', duration_us: '3000000' }),
  ev('m', 5, 'llm_call', 1, 2, { ctx_tokens: '4000' }),
  ev('m', 6, 'tool_call', 1, 2, { parent_seq: '5', name: 'Read', resource: 'tests/clock_test.py', repeat_of: '3', repeat_visible: 1 }),
  ev('m', 7, 'llm_call', 1, 3, { ctx_tokens: '6000' }),
  ev('m', 8, 'tool_call', 1, 3, { parent_seq: '7', name: 'Agent' }),
  ev('m', 10, 'llm_call', 1, 4, { ctx_tokens: '8000', stop_reason: 'end_turn' }),
];
const M2 = [ev('m', 12, 'compaction', 2, 4), ev('m', 13, 'llm_call', 2, 5, { ctx_tokens: '3000', stop_reason: 'end_turn' })];
const A1 = [
  ev('a', 2, 'llm_call', 1, 1, { ctx_tokens: '1000' }), ev('a', 3, 'tool_call', 1, 1, { parent_seq: '2', name: 'Grep', resource: 'src' }),
  ev('a', 4, 'llm_call', 1, 2, { ctx_tokens: '1500', stop_reason: 'end_turn' }),
];
const tree: Tree = buildTree({ sessions: SESSIONS, turns: TURNS, marks: MARKS });
const items = (...lists: [string, number, object[]][]) => new Map<string, Item[]>(lists.map(([sid, n, rows]) => [itemsKey(sid, n), itemsOf(rows as never)]));
const ALL = items(['m', 1, M1], ['m', 2, M2], ['a', 1, A1]);
const shape = (rows: LaneRow[]) => rows.map((r) => `${r.type}:${r.key}@${r.lane}`);
const stepAt = (list: Item[], i: number): Step => {
  const item = list[i];
  if (item?.type !== 'step') throw new Error(`item ${i} is not a step`);
  return item.step;
};
const moreOf = (r: LaneRow | undefined) => (r?.type === 'more' ? [r.loaded, r.left] : null);
const cutOf = (r: LaneRow | undefined) => (r?.type === 'cut' ? [r.before, r.after] : null);

test('the tree: branches with their turns, the main session, marks, and a scale no narrower than 200k tokens', () => {
  assert.equal(tree.main.sid, 'm');
  assert.deepEqual([...tree.branches.keys()], ['m', 'a']);
  assert.deepEqual([...tree.children].map(([call, b]) => [call, b.sid]), [['m#8', 'a']]);
  assert.deepEqual(tree.main.turns.map((t) => [t.no, t.steps, t.firstStep, t.lastCall, t.exact]), [[1, 4, 1, 10, true], [2, 1, 5, 13, true]]);
  assert.deepEqual([tree.branches.get('a')!.name, tree.branches.get('a')!.parent, tree.branches.get('a')!.parentSeq], ['Explore', 'm', 8]);
  assert.equal(tree.marks.length, 4);
  assert.deepEqual([...tree.spawns].map(([child, m]) => [child, m.seq]), [['a', 8]]);
  assert.equal(tree.marksCut, false);
  assert.equal(buildTree({ sessions: SESSIONS, turns: TURNS, marks: MARKS, marksCut: true }).marksCut, true);
  assert.equal(tree.scale, 200_000);
  assert.equal(buildTree({ sessions: [session('m', 'main', { peak_ctx_tokens: '962272' })], turns: [], marks: [] }).scale, 962_272);
  assert.throws(() => buildTree({ sessions: [], turns: [], marks: [] }), /needs a session/);
});

test('light rows become steps with their tool calls, and compactions, in order', () => {
  const list = itemsOf(M1 as never);
  assert.deepEqual(list.map((i) => (i.type === 'step' ? [i.step.seq, i.step.no, i.step.tools.map((t) => t.name)] : 'cut')),
    [[2, 1, ['Read', 'Bash']], [5, 2, ['Read']], [7, 3, ['Agent']], [10, 4, []]]);
  const first = stepAt(list, 0);
  const second = stepAt(list, 1);
  assert.deepEqual([stepFailed(first), stepRepeats(first), stepTotalUs(first)], [true, false, 6_000_000]);
  assert.deepEqual([stepFailed(second), stepRepeats(second), second.tools[0]!.repeatVisible], [false, true, true]);
  assert.deepEqual(itemsOf(M2 as never).map((i) => i.type), ['cut', 'step']);
  assert.deepEqual(childrenOf(tree, stepAt(list, 2)).map((b) => b.sid), ['a']);
  assert.deepEqual(childrenOf(tree, first), []);
});

test('closed turns: one row each; a compaction inside a turn is counted, not drawn', () => {
  const rows = laneRows(tree, { items: new Map(), open: new Set() });
  assert.deepEqual(shape(rows), ['turn:t:m:1@0', 'turn:t:m:2@0']);
  assert.deepEqual(rows.map((r) => [r.from, r.to, r.above, r.below]), [[2000, 8000, false, true], [8000, 3000, true, false]]);
  assert.deepEqual(rows.map((r) => (r.type === 'turn' ? r.inner : null)), [0, 1]);
});

test('an open turn whose steps are not read yet says so; read steps follow their turn', () => {
  const waiting = laneRows(tree, { items: new Map(), open: new Set(['t:m:1']) });
  assert.deepEqual(shape(waiting), ['turn:t:m:1@0', 'more:m:m:1@0', 'turn:t:m:2@0']);
  assert.deepEqual(moreOf(waiting[1]), [0, 4]);
  const open = laneRows(tree, { items: items(['m', 1, M1]), open: new Set(['t:m:1']) });
  assert.deepEqual(shape(open), ['turn:t:m:1@0', 'step:s:m:2@0', 'step:s:m:5@0', 'step:s:m:7@0', 'step:s:m:10@0', 'turn:t:m:2@0']);
  // The lane widens with the context of each request.
  assert.deepEqual(open.map((r) => r.to), [2000, 2000, 4000, 6000, 8000, 3000]);
  const part = laneRows(tree, { items: items(['m', 1, M1.slice(0, 5)]), open: new Set(['t:m:1']) });
  assert.deepEqual(part.filter((r) => r.type === 'more').map(moreOf), [[2, 2]]);
});

test('a sub-agent is a branch off the step that started it; lanes pass by its rows', () => {
  const rows = laneRows(tree, { items: ALL, open: new Set(['t:m:1', 't:m:2', branchKey('a')]) });
  assert.deepEqual(shape(rows), [
    'turn:t:m:1@0', 'step:s:m:2@0', 'step:s:m:5@0', 'step:s:m:7@0', 'step:s:a:2@1', 'step:s:a:4@1', 'step:s:m:10@0', 'turn:t:m:2@0', 'cut:c:m:12@0', 'step:s:m:13@0',
  ]);
  const inner = rows.filter((r) => r.lane === 1);
  // The main lane passes the sub-agent's rows at the size it had when the branch left it.
  assert.deepEqual(inner.map((r) => r.pass), [[6000], [6000]]);
  assert.deepEqual(inner.map((r) => [r.from, r.to, r.below]), [[1000, 1000, true], [1000, 1500, false]]);
  const spawn = rows[3]!;
  assert.deepEqual(spawn.type === 'step' && [spawn.child?.sid, spawn.open, twistOf(spawn), spawn.owner], ['a', true, 'b:a', 't:m:1']);
  assert.deepEqual(inner.map((r) => r.type === 'step' && r.owner), ['b:a', 'b:a']);
  assert.deepEqual(cutOf(rows[8]), [8000, 3000]);
  assert.equal(rows[rows.length - 1]!.below, false);
});

test('a compaction after the last model call of a turn has a row even while the turn is closed', () => {
  const marks = [...MARKS, mark(11, 'compaction', 1, 4)];
  const t = buildTree({ sessions: SESSIONS, turns: TURNS, marks });
  const closed = laneRows(t, { items: new Map(), open: new Set() });
  assert.deepEqual(shape(closed), ['turn:t:m:1@0', 'cut:c:m:11@0', 'turn:t:m:2@0']);
  assert.deepEqual(cutOf(closed[1]), [8000, 3000]);
  // Once the whole turn is read, the compaction is among its rows and is not added again.
  const rowsOfTurn = [...M1, ev('m', 11, 'compaction', 1, 4)];
  const open = laneRows(t, { items: items(['m', 1, rowsOfTurn]), open: new Set(['t:m:1']) });
  assert.equal(open.filter((r) => r.key === 'c:m:11').length, 1);
});

test('the chain of a closed turn: equal neighbours are counted, a failed call stands alone, nine links at most', () => {
  assert.deepEqual(chain('Read,Read,Bash failed,Bash failed,Edit').links,
    [{ name: 'Read', n: 2, bad: false }, { name: 'Bash', n: 1, bad: true }, { name: 'Bash', n: 1, bad: true }, { name: 'Edit', n: 1, bad: false }]);
  assert.deepEqual(chain(''), { links: [], more: false });
  const long = chain(Array.from({ length: 12 }, (_, i) => `T${i}`).join(','));
  assert.deepEqual([long.links.length, long.more], [9, true]);
});

test('what a step did, in one line', () => {
  const list = itemsOf(M1 as never);
  assert.deepEqual(stepLabel(stepAt(list, 0), [], true), { tool: 'Read', text: 'tests/clock_test.py', extra: 1 });
  assert.deepEqual(stepLabel(stepAt(list, 2), [tree.branches.get('a')!], true), { tool: 'Agent', text: 'Explore', extra: 0 });
  assert.deepEqual(stepLabel(stepAt(list, 3), [], true), { tool: null, text: 'Reply to the user', extra: 0 });
  assert.equal(stepLabel(stepAt(list, 3), [], false).text, 'Return the result');
});

test('drawing: row kinds, the width of a lane, and the shape of a lane through a row', () => {
  assert.deepEqual([kindOf({ type: 'turn', open: false }), kindOf({ type: 'turn', open: true }), kindOf({ type: 'cut' })], ['closed', 'turn', 'cut']);
  assert.deepEqual([half(0, 200_000), half(100_000, 200_000), half(900_000, 200_000)], [1, 4, 8]);
  assert.deepEqual([indent(0), indent(1)], [48, 68]);
  const g = { lane: 0, from: 100_000, at: 100_000, to: 200_000, above: true, below: true };
  assert.equal(bandPath({ ...g, kind: 'step' }, 200_000), 'M16,0L16,14L12,28L28,28L24,14L24,0Z');
  // The first row starts at its node; the last one ends there.
  assert.equal(bandPath({ ...g, kind: 'step', above: false }, 200_000), 'M16,14L12,28L28,28L24,14Z');
  assert.equal(bandPath({ ...g, kind: 'step', below: false }, 200_000), 'M16,0L16,14L24,14L24,0Z');
  // A closed turn that ends the session keeps a short tail; a compaction is a funnel.
  assert.equal(bandPath({ ...g, kind: 'closed', below: false }, 200_000), 'M16,0L16,18L12,44L28,44L24,18L24,0Z');
  assert.equal(bandPath({ ...g, kind: 'cut', from: 200_000, to: 25_000 }, 200_000), 'M12,0V8C12,17 19,17 19,26V34H21V26C21,17 28,17 28,8V0Z');
  assert.equal(bandPath({ ...g, kind: 'more' }, 200_000), null);
});

test('only the rows near the window are drawn: tops by row height, and the rows a window touches', () => {
  const rows = laneRows(tree, { items: ALL, open: new Set(['t:m:1', branchKey('a')]) });
  // An open turn, six steps, a closed turn: 36 + 6 x 28 + 54.
  const tops = rowTops(rows);
  assert.deepEqual(tops, [0, 36, 64, 92, 120, 148, 176, 204, 258]);
  assert.deepEqual(windowOf(tops, 0, 100, 0), [0, 4]);
  assert.deepEqual(windowOf(tops, 64, 28, 0), [2, 3]);
  assert.deepEqual(windowOf(tops, 64, 28, 30), [0, 5]);
  assert.deepEqual(windowOf(tops, 250, 500, 0), [7, 8]);
  assert.deepEqual(windowOf(tops, -50, 20, 0), [0, 0]);
  assert.deepEqual(windowOf(tops, 900, 100, 0), [8, 8]);
  assert.deepEqual(windowOf(tops, 0, 10_000, 600), [0, 8]);
  assert.deepEqual([rowTops([]), windowOf([0], 0, 100, 600)], [[0], [0, 0]]);
  // Ten thousand rows: the window is found without walking the list.
  const many = Array.from({ length: 10_001 }, (_, i) => i * 28);
  assert.deepEqual(windowOf(many, 140_000, 900, 600), [4978, 5054]);
});

test('the way to a place: what to open and how many steps of which turns to read', () => {
  assert.deepEqual(reveal(tree, { sid: 'm', turn: 2, stepNo: null }), { open: [], load: [] });
  assert.deepEqual(reveal(tree, { sid: 'm', turn: 1, stepNo: 3 }), { open: ['t:m:1'], load: [{ sid: 'm', turn: 1, steps: 3 }] });
  assert.deepEqual(reveal(tree, { sid: 'm', turn: 2, stepNo: 5 }), { open: ['t:m:2'], load: [{ sid: 'm', turn: 2, steps: 1 }] });
  // A compaction before the first call of its turn carries the ordinal of the call before it.
  assert.deepEqual(reveal(tree, { sid: 'm', turn: 2, stepNo: 4 }).load, [{ sid: 'm', turn: 2, steps: 1 }]);
  // A step of a sub-agent: the turn and the step that started it, then the branch.
  assert.deepEqual(reveal(tree, { sid: 'a', turn: 1, stepNo: 2 }),
    { open: ['t:m:1', 'b:a'], load: [{ sid: 'm', turn: 1, steps: 3 }, { sid: 'a', turn: 1, steps: 2 }] });
  assert.deepEqual(reveal(tree, { sid: 'a', turn: 1, stepNo: null }), { open: ['t:m:1', 'b:a'], load: [{ sid: 'm', turn: 1, steps: 3 }] });
  assert.deepEqual(reveal(tree, { sid: 'nobody', turn: 1, stepNo: 1 }), { open: [], load: [] });
});

test('pages of a turn still to read', () => {
  assert.deepEqual(pagesToRead(0, 100, 558), [0]);
  assert.deepEqual(pagesToRead(100, 450, 558), [100, 200, 300, 400]);
  assert.deepEqual(pagesToRead(0, 450, 558), [0, 100, 200, 300, 400]);
  assert.deepEqual(pagesToRead(500, 600, 558), [500]);
  assert.deepEqual(pagesToRead(558, 600, 558), []);
  assert.deepEqual(pagesToRead(100, 100, 558), []);
  assert.deepEqual(pagesToRead(0, 5, 0), []);
});

test('what the Jump to buttons visit, in the order of the tree', () => {
  assert.deepEqual(jumpTargets(tree, 'failed'), [{ key: 's:m:2', sid: 'm', turn: 1, stepNo: 1 }]);
  assert.deepEqual(jumpTargets(tree, 'repeated').map((t) => t.key), ['s:m:5']);
  assert.deepEqual(jumpTargets(tree, 'subagent').map((t) => t.key), ['s:m:7']);
  assert.deepEqual(jumpTargets(tree, 'compaction'), [{ key: 'c:m:12', sid: 'm', turn: 2, stepNo: 4 }]);
  // A failed call of the sub-agent comes after the call that started it and before what follows in the main session.
  const more = [...MARKS, { ...mark(3, 'tool_call', 1, 1, { parent_seq: '2', failed: 1 }), session_id: 'a' }, mark(9, 'tool_call', 1, 4, { parent_seq: '10', failed: 1 })];
  const t = buildTree({ sessions: SESSIONS, turns: TURNS, marks: more });
  assert.deepEqual(jumpTargets(t, 'failed').map((x) => x.key), ['s:m:2', 's:a:2', 's:m:10']);
  // Two failed calls of one step are one place.
  const twice = buildTree({ sessions: SESSIONS, turns: TURNS, marks: [...MARKS, mark(3, 'tool_call', 1, 1, { parent_seq: '2', failed: 1 })] });
  assert.deepEqual(jumpTargets(twice, 'failed').map((x) => x.key), ['s:m:2']);
});

test('the next target follows the selected one and returns to the first', () => {
  const targets = jumpTargets(buildTree({ sessions: SESSIONS, turns: TURNS, marks: [...MARKS, mark(9, 'tool_call', 1, 4, { parent_seq: '10', failed: 1 })] }), 'failed');
  assert.equal(nextTarget(targets, null)!.key, 's:m:2');
  assert.equal(nextTarget(targets, 's:m:2')!.key, 's:m:10');
  assert.equal(nextTarget(targets, 's:m:10')!.key, 's:m:2');
  assert.equal(nextTarget(targets, 't:m:1')!.key, 's:m:2');
  assert.equal(nextTarget([], 's:m:2'), null);
});

// The same session with a second sub-agent started by the same step, as when helpers run side by side.
const TWO_SESSIONS = [...SESSIONS, session('b', 'subagent', { parent_id: 'm', parent_seq: '9', agent_name: 'Plan', title: 'second helper' })];
const TWO_TURNS = [...TURNS, turn('b', 1, { steps: '1', ctx_first: '700', ctx_last: '700', first_step: 1, last_call: '2', ctx_exact: 0 })];
const TWO_MARKS = [...MARKS, mark(9, 'tool_call', 1, 3, { parent_seq: '7', child: 'b' })];
const M1_TWO = [...M1.slice(0, 7), ev('m', 9, 'tool_call', 1, 3, { parent_seq: '7', name: 'Agent' }), M1[7]!];
const B1 = [ev('b', 2, 'llm_call', 1, 1, { ctx_tokens: '700', stop_reason: 'end_turn' })];

test('a step that started several sub-agents: each has a row of its own under the step and opens on its own', () => {
  const two = buildTree({ sessions: TWO_SESSIONS, turns: TWO_TURNS, marks: TWO_MARKS });
  const all = items(['m', 1, M1_TWO], ['m', 2, M2], ['a', 1, A1], ['b', 1, B1]);
  const closed = laneRows(two, { items: all, open: new Set(['t:m:1']) });
  assert.deepEqual(shape(closed), ['turn:t:m:1@0', 'step:s:m:2@0', 'step:s:m:5@0', 'step:s:m:7@0', 'branch:t:a:1@1', 'branch:t:b:1@1', 'step:s:m:10@0', 'turn:t:m:2@0']);
  const spawn = closed[3]!;
  assert.deepEqual(spawn.type === 'step' && [spawn.child, spawn.children.map((b) => b.sid), twistOf(spawn)], [null, ['a', 'b'], null]);
  assert.deepEqual(spawn.type === 'step' && stepLabel(spawn.step, spawn.children, true), { tool: 'Agent', text: '2 sub-agents', extra: 0 });
  assert.deepEqual([twistOf(closed[4]!), twistOf(closed[5]!)], ['b:a', 'b:b']);
  // Each sub-agent's lane starts at its own row; a closed one ends there.
  assert.deepEqual(closed.slice(4, 6).map((r) => [r.from, r.to, r.above, r.below, r.pass]), [[1000, 1000, false, false, [6000]], [700, 700, false, false, [6000]]]);

  const open = laneRows(two, { items: all, open: new Set(['t:m:1', 'b:b']) });
  assert.deepEqual(shape(open).slice(3, 8), ['step:s:m:7@0', 'branch:t:a:1@1', 'branch:t:b:1@1', 'step:s:b:2@1', 'step:s:m:10@0']);
  assert.deepEqual(open.slice(4, 7).map((r) => [r.above, r.below]), [[false, false], [false, true], [true, false]]);
  const inner = open[6]!;
  assert.equal(inner.type === 'step' && inner.owner, 'b:b');
  // The way to a step of the second sub-agent opens the turn and that branch.
  assert.deepEqual(reveal(two, { sid: 'b', turn: 1, stepNo: 1 }), { open: ['t:m:1', 'b:b'], load: [{ sid: 'm', turn: 1, steps: 3 }, { sid: 'b', turn: 1, steps: 1 }] });
  assert.deepEqual(jumpTargets(two, 'subagent').map((t) => t.key), ['s:m:7']);
});

test('a compaction in a turn without a model call has a row, since the turn cannot open', () => {
  const turns = [...TURNS, turn('m', 3, { compactions: '1', ctx_first: '0', ctx_last: '0' })];
  const t = buildTree({ sessions: SESSIONS, turns, marks: [...MARKS, mark(15, 'compaction', 3, 5)] });
  const rows = laneRows(t, { items: new Map(), open: new Set() });
  assert.deepEqual(shape(rows), ['turn:t:m:1@0', 'turn:t:m:2@0', 'turn:t:m:3@0', 'cut:c:m:15@0']);
  const third = rows[2]!;
  assert.equal(third.type === 'turn' && third.inner, 0);
});

test('long turns, long chains and many marks are read in one pass', () => {
  const n = 20_000;
  const rows = Array.from({ length: n }, (_, i) => [ev('m', 2 * i + 2, 'llm_call', 1, i + 1), ev('m', 2 * i + 3, 'tool_call', 1, i + 1, { parent_seq: String(2 * i + 2), name: 'Bash' })]).flat();
  const marks = Array.from({ length: n }, (_, i) => mark(2 * i + 3, 'tool_call', 1, i + 1, { parent_seq: String(2 * i + 2), failed: 1 }));
  const big = buildTree({ sessions: SESSIONS, turns: TURNS, marks: [...MARKS, ...marks] });
  const started = performance.now();
  const list = itemsOf(rows as never);
  const links = chain(Array.from({ length: n }, (_, i) => `T${i}`).join(','));
  const targets = jumpTargets(big, 'failed');
  const took = performance.now() - started;
  assert.deepEqual([list.length, stepAt(list, n - 1).tools.map((t) => t.name), links.links.length, links.more, targets.length], [n, ['Bash'], 9, true, n]);
  // Work that grows with the square of the size takes many seconds here.
  assert.ok(took < 1500, `took ${Math.round(took)} ms`);
});

test('a turn of a sub-agent has no row of its own: the row that stands for it is the one of its branch', () => {
  // The only sub-agent of a step is drawn under that step.
  assert.equal(rowKeyOf(tree, 't:a:1'), 's:m:7');
  // Several sub-agents of one step have a row each.
  const two = buildTree({ sessions: TWO_SESSIONS, turns: TWO_TURNS, marks: TWO_MARKS });
  assert.deepEqual([rowKeyOf(two, 't:a:1'), rowKeyOf(two, 't:b:1')], ['t:a:1', 't:b:1']);
  // Everything else is its own row: a turn of the main session, a step, a compaction, a key the tree does not know.
  assert.deepEqual(['t:m:2', 's:a:2', 'c:m:12', 't:zz:1', 'nonsense'].map((k) => rowKeyOf(tree, k)), ['t:m:2', 's:a:2', 'c:m:12', 't:zz:1', 'nonsense']);
});
