// The Sequences page as data: its state in the address, a pattern in words, the drawing of the
// paths, and the marks a match leaves on the session page.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Match, PathTree } from '../src/api/sequences.ts';
import { BOX, COL, drawPaths, PADX, ROW } from '../src/lib/agents/path-draw.ts';
import { parseMarks } from '../src/lib/agents/select.ts';
import {
  added, EXAMPLES, type Step, matchMarks, nodeOf, parseSeqState, patternOfPath, serializeSeqState, sortOf, startLabel, stepLabel, withStep, without, words,
} from '../src/lib/agents/sequences.ts';

test('an address without a pattern is the drawing, from a failed call over seven days', () => {
  assert.deepEqual(parseSeqState(''), { range: { preset: '7d' }, start: 'failed', pattern: null, sort: 'time', dir: 'desc' });
  assert.equal(serializeSeqState(parseSeqState('')), '');
  assert.deepEqual(parseSeqState('?t=24h&start=tool%3ABash').start, 'tool:Bash');
  assert.equal(serializeSeqState(parseSeqState('?t=24h&start=tool%3ABash')), '?t=24h&start=tool%3ABash');
  assert.equal(parseSeqState('?start=Bash').start, 'failed', 'a start the page does not know is the default');
});

test('a pattern and its sort go through the address unchanged', () => {
  const pattern: Step[] = [{ kind: 'call', tool: 'Edit' }, { kind: 'call', tool: 'Bash', status: 'failed', has: 'test', link: 'next' }, { kind: 'call', tool: 'Edit', same: 1, link: 'later' }];
  const state = { range: { from: 1000, to: 2000 }, start: 'user', pattern, sort: 'step2', dir: 'asc' as const };
  const address = serializeSeqState(state);
  assert.deepEqual(parseSeqState(address), state);
  assert.match(address, /^\?from=1000&to=2000&start=user&p=%5B/);
  // Sorting by a step the pattern does not have falls back to the time.
  assert.equal(parseSeqState(serializeSeqState({ ...state, sort: 'step4' })).sort, 'time');
  assert.equal(sortOf('span', 3), 'span');
  assert.equal(sortOf('colour', 3), 'time');
});

test('a pattern the address spells wrongly is cleaned or dropped', () => {
  const p = (raw: unknown) => parseSeqState(`?p=${encodeURIComponent(JSON.stringify(raw))}`).pattern;
  assert.equal(parseSeqState('?p=nonsense').pattern, null);
  assert.equal(p([]), null);
  assert.equal(p(Array.from({ length: 7 }, () => ({ tool: 'Read' }))), null);
  assert.equal(p({ tool: 'Read' }), null);
  assert.deepEqual(p([{ tool: 'Read', status: 'done', has: 7, colour: 'red' }, { kind: 'user', tool: 'Bash', same: 4 }, { kind: 'jump', link: 'later', same: 1 }]), [
    { kind: 'call', tool: 'Read' }, { kind: 'user', link: 'next' }, { kind: 'call', same: 1, link: 'later' },
  ]);
  assert.deepEqual(p([{ kind: 'compaction', has: 'x' }, { tool: 'Edit', same: 1, link: 'next' }]), [{ kind: 'compaction' }, { kind: 'call', tool: 'Edit', link: 'next' }]);
});

test('a step in words, as short as the paper writes one', () => {
  assert.deepEqual(EXAMPLES[0]!.steps.map(words), [['Edit'], ['Bash', 'failed', 'target has "test"'], ['Edit', 'same target as 1']]);
  assert.deepEqual(EXAMPLES[2]!.steps.map(words), [['Reply', 'text has "should i"'], ['User input'], ['Bash']]);
  assert.deepEqual(words({ kind: 'call' }), ['Any tool']);
  assert.deepEqual(words({ kind: 'call', any: ['rm -rf', 'drop table'] }), ['Any tool', 'target has "rm -rf" or "drop table"']);
  assert.deepEqual(words({ kind: 'user', same: 2, link: 'later' }), ['User input', 'same text as 2']);
  assert.deepEqual([stepLabel({ kind: 'call' }), stepLabel({ kind: 'call', tool: 'Grep' }), stepLabel({ kind: 'compaction' })], ['Any tool', 'Grep', 'Compaction']);
});

test('removing a step renumbers the steps that named a target', () => {
  const pattern: Step[] = [{ kind: 'call', tool: 'Read' }, { kind: 'call', tool: 'Edit', link: 'next' }, { kind: 'call', same: 1, link: 'later' }, { kind: 'call', same: 2, link: 'next' }, { kind: 'call', same: 3, link: 'next' }];
  assert.deepEqual(without(pattern, 1), [{ kind: 'call', tool: 'Read' }, { kind: 'call', same: 1, link: 'later' }, { kind: 'call', link: 'next' }, { kind: 'call', same: 2, link: 'next' }]);
  // The step that becomes the first follows nothing.
  assert.deepEqual(without(pattern.slice(0, 2), 0), [{ kind: 'call', tool: 'Edit' }]);
});

test('changing and adding steps', () => {
  const pattern: Step[] = [{ kind: 'call', tool: 'Read' }, { kind: 'call', same: 1, link: 'later' }];
  assert.deepEqual(added(pattern), [...pattern, { kind: 'call', link: 'next' }]);
  // A step that becomes a compaction can no longer be the target of a later step.
  assert.deepEqual(withStep(pattern, 0, { kind: 'compaction' }), [{ kind: 'compaction' }, { kind: 'call', link: 'later' }]);
  assert.deepEqual(withStep(pattern, 1, { kind: 'user', has: 'yes', link: 'next' }), [{ kind: 'call', tool: 'Read' }, { kind: 'user', has: 'yes', link: 'next' }]);
});

test('an event of the drawing, and the pattern a path opens as', () => {
  assert.deepEqual(nodeOf('c:Bash'), { kind: 'call', tool: 'Bash', failed: false, label: 'Bash' });
  assert.deepEqual(nodeOf('f:mcp:x'), { kind: 'call', tool: 'mcp:x', failed: true, label: 'mcp:x failed' });
  assert.deepEqual([nodeOf('u:').label, nodeOf('r:').label, nodeOf('x:').label, nodeOf('').label], ['User input', 'Reply', 'Compaction', 'session ends']);
  assert.deepEqual(patternOfPath('failed', ['c:Read', 'f:Bash', 'u:']), [
    { kind: 'call', status: 'failed' }, { kind: 'call', tool: 'Read', status: 'ok', link: 'next' }, { kind: 'call', tool: 'Bash', status: 'failed', link: 'next' }, { kind: 'user', link: 'next' },
  ]);
  assert.deepEqual(patternOfPath('tool:Grep', []), [{ kind: 'call', tool: 'Grep' }]);
  assert.deepEqual(patternOfPath('user', ['r:']), [{ kind: 'user' }, { kind: 'reply', link: 'next' }]);
  assert.deepEqual([startLabel('failed'), startLabel('user'), startLabel('tool:Bash')], ['Failed call', 'User input', 'Bash']);
});

const TREE: PathTree = {
  total: 200,
  kids: [
    { key: 'c:Edit', times: 120, other: { count: 4, times: 20 }, kids: [{ key: 'f:Bash', times: 100, other: null, kids: [] }] },
    { key: '', times: 50, other: null, kids: [] },
  ],
  other: { count: 9, times: 30 },
};

test('the drawing: a column per event, a row per leaf, a node between its branches', () => {
  const d = drawPaths(TREE, 'tool:Read');
  // Leaves from the top: the failed Bash, the other branches of Edit, "session ends", the other branches of the start.
  assert.deepEqual(d.nodes.map((n) => [n.label, n.count, n.x, n.y]), [
    ['Read', '200', PADX, 2.25 * ROW],
    ['Edit', '60%', PADX + COL, 1.5 * ROW - ROW / 2],
    ['Bash failed', '50%', PADX + 2 * COL, ROW / 2],
    ['4 other', '10%', PADX + 2 * COL, ROW + ROW / 2],
    ['session ends', '25%', PADX + COL, 2 * ROW + ROW / 2],
    ['9 other', '15%', PADX + COL, 3 * ROW + ROW / 2],
  ]);
  assert.deepEqual(d.nodes.map((n) => [n.tone, n.dim]), [['', false], ['', false], ['bad', false], ['', true], ['', true], ['', true]]);
  assert.deepEqual(d.nodes.map((n) => n.pattern?.length ?? 0), [1, 2, 3, 0, 0, 0]);
  assert.deepEqual(d.nodes[2]!.pattern, [{ kind: 'call', tool: 'Read' }, { kind: 'call', tool: 'Edit', status: 'ok', link: 'next' }, { kind: 'call', tool: 'Bash', status: 'failed', link: 'next' }]);
  assert.deepEqual([d.width, d.height], [PADX * 2 + 3 * COL + BOX, 4 * ROW]);
  // A line per branch, as thick as the branch is common, red into a failed call.
  assert.deepEqual(d.links.map((l) => [l.width, l.bad]), [[13.2, false], [11, true], [2.2, false], [5.5, false], [3.3, false]]);
  assert.equal(d.links[0]!.d, `M${PADX + BOX},${d.nodes[0]!.y}C${PADX + BOX + (COL - BOX) / 2},${d.nodes[0]!.y} ${PADX + BOX + (COL - BOX) / 2},${d.nodes[1]!.y} ${PADX + COL},${d.nodes[1]!.y}`);
});

test('the drawing clips a long name and keeps it whole in the title', () => {
  const d = drawPaths({ total: 1, kids: [{ key: 'c:mcp__claude_ai_Claude_Docs__update', times: 1, kids: [], other: null }], other: null }, 'user');
  assert.deepEqual([d.nodes[1]!.label, d.nodes[1]!.title], ['mcp__claude_a…', 'mcp__claude_ai_Claude_Docs__update']);
  assert.equal(d.nodes[0]!.tone, 'ev');
  assert.deepEqual(drawPaths({ total: 0, kids: [], other: null }, 'failed'), { width: 0, height: 0, nodes: [], links: [] });
  // A branch that is drawn but rounds to nothing does not read as none.
  const rare = drawPaths({ total: 1000, kids: [{ key: 'c:Read', times: 996, kids: [], other: null }], other: { count: 2, times: 4 } }, 'user');
  assert.deepEqual(rare.nodes.map((n) => n.count), ['1,000', '100%', '<1%']);
});

const MATCH: Match = {
  session_id: 'agent-h1', root_id: 'fx', title: 'T', agent: 'Explore', ts: '2026-11-17 10:00:00', turn: 2, span: 9,
  steps: [
    { kind: 'user', seq: 10, call: null, ts: '', turn: 2, step: 3, what: 'User input', status: '', target: 'yes' },
    { kind: 'call', seq: 14, call: 12, ts: '', turn: 2, step: 4, what: 'Bash', status: 'ok', target: 'ls' },
    { kind: 'reply', seq: 20, call: null, ts: '', turn: 2, step: 6, what: 'Reply', status: '', target: 'Done.' },
    { kind: 'compaction', seq: 21, call: null, ts: '', turn: 2, step: 6, what: 'Compaction', status: '', target: '' },
  ],
};

test('a match marks the rows of its events on the session page', () => {
  const raw = matchMarks(MATCH);
  assert.equal(raw, 'agent-h1;t2,s2.4.12,s2.6.20,c2.6.21');
  assert.deepEqual(parseMarks(raw), [
    { key: 't:agent-h1:2', sid: 'agent-h1', turn: 2, stepNo: null },
    { key: 's:agent-h1:12', sid: 'agent-h1', turn: 2, stepNo: 4 },
    { key: 's:agent-h1:20', sid: 'agent-h1', turn: 2, stepNo: 6 },
    { key: 'c:agent-h1:21', sid: 'agent-h1', turn: 2, stepNo: 6 },
  ]);
  assert.deepEqual(parseMarks(null), []);
  assert.deepEqual(parseMarks('agent-h1;t2,x9,s1.2,s1.2.3.4,c0.0.7'), [{ key: 't:agent-h1:2', sid: 'agent-h1', turn: 2, stepNo: null }, { key: 'c:agent-h1:7', sid: 'agent-h1', turn: 0, stepNo: 0 }]);
  assert.deepEqual(parseMarks('no-items'), []);
});
