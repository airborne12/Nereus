// The right side of the session page as a chat, without a browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Block, blockOf, bubbles, callLine, callOf, clamp, CLAMP_CHARS, groups, inputView, speakerOf } from '../src/lib/agents/chat.ts';

const row = (msg_seq: number, msg_role: string, kind: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ msg_seq: String(msg_seq), ts: '2026-11-17 10:00:00.000000', msg_role, kind, api_msg: msg_seq, tool_name: null, tool_call_id: null, is_error: null, tokens: 3, text, chars: text.length, ...extra });
const block = (msg_seq: number, msg_role: string, kind: string, text: string, extra: Record<string, unknown> = {}): Block => blockOf(row(msg_seq, msg_role, kind, text, extra));

test('a block from its row; a tool result of a step carries the call it answers', () => {
  const b = blockOf(row(7, 'tool', 'tool_result', 'FAILED', {
    tool_name: 'Bash', tool_call_id: 't2', is_error: 1, event_kind: 'tool_call', event_seq: '4', name: 'Bash', resource: 'pytest', status: 'error',
    duration_us: '3000000', repeat_of: '3', repeat_visible: 0,
  }));
  assert.deepEqual([b.seq, b.role, b.kind, b.tool, b.callId, b.failed, b.chars], [7, 'tool', 'tool_result', 'Bash', 't2', true, 6]);
  assert.deepEqual(b.call, { seq: 4, name: 'Bash', resource: 'pytest', durationUs: 3_000_000, repeatOf: 3, repeatVisible: false });
  assert.equal(blockOf(row(3, 'assistant', 'text', 'hi', { event_kind: 'llm_call' })).call, undefined);
  assert.equal(blockOf(row(6, 'tool', 'tool_result', 'ok', { is_error: 0 })).failed, false);
});

test('who speaks: a summary and an injected attachment are named for what they are, a sub-agent answers as itself', () => {
  assert.equal(speakerOf(block(1, 'user', 'text', 'hi')), 'user');
  assert.equal(speakerOf(block(2, 'user', 'attachment', '<system-reminder>')), 'attachment');
  assert.equal(speakerOf(block(3, 'user', 'summary', 'Summary')), 'summary');
  assert.equal(speakerOf(block(4, 'assistant', 'tool_use', 'Read {}')), 'assistant');
  assert.equal(speakerOf(block(5, 'tool', 'tool_result', 'x', { tool_name: 'Read' })), 'tool');
  assert.equal(speakerOf(block(6, 'tool', 'tool_result', 'x', { tool_name: 'Agent' })), 'agent');
  assert.equal(speakerOf(block(7, 'system', 'text', 'You are')), 'system');
  // A request's own copy of a tool result or of an answer keeps its speaker.
  assert.equal(speakerOf(block(8, 'tool', 'attachment', 'x')), 'tool');
  assert.equal(speakerOf(block(9, 'assistant', 'attachment', 'x')), 'assistant');
});

test('neighbours of one speaker share a group; empty blocks are left out', () => {
  const list = [
    block(1, 'user', 'text', 'fix it'), block(2, 'user', 'attachment', 'a'), block(3, 'user', 'attachment', 'b'),
    block(4, 'assistant', 'thinking', ''), block(5, 'assistant', 'text', 'reading', { api_msg: 5 }), block(6, 'assistant', 'tool_use', 'Read {}', { api_msg: 5 }),
    block(7, 'assistant', 'tool_use', '', { api_msg: 7 }),
    block(8, 'tool', 'tool_result', 'x', { tool_name: 'Read' }), block(9, 'tool', 'tool_result', 'y', { tool_name: 'Bash' }),
    block(10, 'tool', 'tool_result', 'r1', { tool_name: 'Agent' }), block(11, 'tool', 'tool_result', 'r2', { tool_name: 'Agent' }),
  ];
  assert.deepEqual(groups(list).map((g) => [g.who, g.parts.map((b) => b.seq)]),
    [['user', [1]], ['attachment', [2]], ['attachment', [3]], ['assistant', [5, 6, 7]], ['tool', [8, 9]], ['agent', [10]], ['agent', [11]]]);
  assert.deepEqual(bubbles(groups(list)[3]!.parts).map((p) => p.map((b) => b.seq)), [[5, 6], [7]]);
  assert.deepEqual(groups([]), []);
});

test('a tool call as its tool and one line of arguments', () => {
  assert.deepEqual(callOf(block(1, 'assistant', 'tool_use', 'Bash {"command":"pytest  tests/\\n -q","description":"run"}', { tool_name: 'Bash' })), { name: 'Bash', args: 'pytest tests/ -q' });
  assert.deepEqual(callOf(block(1, 'assistant', 'tool_use', 'Read {"file_path":"a.py","limit":5}')), { name: 'Read', args: 'a.py' });
  assert.deepEqual(callOf(block(1, 'assistant', 'tool_use', 'Odd {"n":1}')), { name: 'Odd', args: '{"n":1}' });
  assert.deepEqual(callOf(block(1, 'assistant', 'tool_use', 'Bare')), { name: 'Bare', args: '' });
  // Text cut short is not JSON any more: it is shown as written.
  assert.deepEqual(callOf(block(1, 'assistant', 'tool_use', 'Write {"file_path":"a')), { name: 'Write', args: '{"file_path":"a' });
  const long = callOf(block(1, 'assistant', 'tool_use', `Bash {"command":"${'x'.repeat(400)}"}`));
  assert.equal(long.args.length, 241);
});

test('the call a tool result answers: from its own step, from the blocks around it, or by its tool', () => {
  const use = block(4, 'assistant', 'tool_use', 'Read {"file_path":"a.py"}', { tool_name: 'Read', tool_call_id: 't1' });
  const result = block(6, 'tool', 'tool_result', 'x', { tool_name: 'Read', tool_call_id: 't1' });
  assert.equal(callLine(result, [use, result]), 'Read a.py');
  assert.equal(callLine(result, [result]), 'Read');
  assert.equal(callLine(block(8, 'tool', 'attachment', 'x'), []), 'Tool result');
  const own = blockOf(row(6, 'tool', 'tool_result', 'x', { event_kind: 'tool_call', event_seq: '3', name: 'Read', resource: 'b.py', duration_us: '1' }));
  assert.equal(callLine(own, [use]), 'Read b.py');
});

test("a step's input: what is new and what earlier requests had, oldest first", () => {
  const latestFirst = [5, 4, 3, 2, 1].map((n) => block(n, 'user', 'text', `m${n}`));
  const all = inputView(latestFirst, 5, 2);
  assert.deepEqual([all.earlier.map((b) => b.seq), all.fresh.map((b) => b.seq), all.earlierTotal, all.unread], [[1, 2, 3], [4, 5], 3, 0]);
  const fresh = inputView(latestFirst, 5, 5);
  assert.deepEqual([fresh.earlier.length, fresh.fresh.length, fresh.earlierTotal], [0, 5, 0]);
  // Of 300 blocks, 100 are read and 150 are new: no earlier block is on screen, and the oldest read message waits for the next page.
  const page = Array.from({ length: 100 }, (_, i) => block(300 - i, 'user', 'text', 'x'));
  const part = inputView(page, 300, 150);
  assert.deepEqual([part.earlier.length, part.fresh.length, part.earlierTotal, part.unread], [0, 99, 150, 200]);
});

test('while older blocks are unread, the oldest read blocks of a message cut in two wait for the rest of it', () => {
  const latestFirst = [
    block(6, 'user', 'text', 'new'), block(5, 'assistant', 'tool_use', 'Bash {}', { api_msg: 4 }), block(4, 'assistant', 'tool_use', 'Read {}', { api_msg: 4 }),
  ];
  const cut = inputView(latestFirst, 10, 1);
  assert.deepEqual([cut.earlier.map((b) => b.seq), cut.fresh.map((b) => b.seq), cut.unread], [[], [6], 7]);
  // Nothing is held back when everything is read, or when the page holds one message only.
  assert.deepEqual(inputView(latestFirst, 3, 1).earlier.map((b) => b.seq), [4, 5]);
  assert.deepEqual(inputView(latestFirst.slice(1), 10, 0).earlier.map((b) => b.seq), [4, 5]);
});

test('a long text shows its start until it is opened', () => {
  const long = 'x'.repeat(CLAMP_CHARS + 500);
  assert.deepEqual([clamp(long, false).shown.length, clamp(long, false).hidden], [CLAMP_CHARS, 500]);
  assert.deepEqual([clamp(long, true).shown.length, clamp(long, true).hidden], [CLAMP_CHARS + 500, 0]);
  assert.deepEqual(clamp('short', false), { shown: 'short', hidden: 0 });
});
