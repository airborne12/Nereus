// The Claude Code transcript adapter, alone and followed by the normaliser, on the hand-written fixture.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTranscript } from '../src/semantics/adapters/claude-transcript.ts';
import { apiMessageHash } from '../src/semantics/trajectory/hash.ts';
import type { SessionRecord } from '../src/semantics/trajectory/model.ts';
import { normalise } from '../src/semantics/trajectory/normalise.ts';
import { agentLines, MAIN_ID, mainLines } from './fixtures/claude-transcript.ts';

const session = (id: string): SessionRecord => ({ type: 'session', id, rootId: MAIN_ID, parentId: null, spawnToolCallId: null,
  kind: 'main', title: null, agentName: null, runtime: 'claude-code', runtimeVersion: null, startedAt: '2026-11-17T10:00:00.000Z' });

test('records in file order; unknown rows counted; bookkeeping ignored; malformed lines counted', () => {
  const r = readTranscript(mainLines());
  assert.deepEqual(r.records.map((x) => x.type), ['prompt', 'input', 'input', 'call', 'input', 'input', 'call', 'input', 'call', 'input',
    'error', 'call', 'turn_end', 'input', 'compaction', 'input', 'call']);
  assert.deepEqual([r.title, r.runtimeVersion, r.startedAt, r.malformed, r.unresolved, r.hasRequestLog],
    ['Fix the clock test', '2.1.322', '2026-11-17T10:00:00.000Z', 1, 0, true]);
  assert.deepEqual(r.skipped, { mystery: 1 });
});

test('an assistant message spread over rows is one call with its request-log context', () => {
  const calls = readTranscript(mainLines()).records.filter((x) => x.type === 'call');
  const first = calls[0]!;
  assert.equal(first.type, 'call');
  if (first.type !== 'call') return;
  assert.deepEqual(first.blocks.map((b) => [b.kind, b.toolName]), [['text', null], ['tool_use', 'Read'], ['tool_use', 'Bash']]);
  assert.deepEqual([first.startTs, first.endTs, first.requestId, first.model, first.promptHash, first.stopReason],
    ['2026-11-17T10:00:01.000Z', '2026-11-17T10:00:03.000Z', 'req_m1', 'claude-opus-5-5', 'shape1', 'tool_use']);
  assert.deepEqual(first.usage, { input: 10, output: 20, cacheRead: 100, cacheWrite: 5 });
  assert.equal(first.context?.tail.length, 2);
  const second = calls[1]!;
  if (second.type !== 'call') return;
  assert.deepEqual(second.context && [second.context.base, second.context.keep, second.context.tail], ['r1', 2, [['m1'], ['u2', 'u3']]]);
});

test('the fixture normalised: turns, steps, contexts, repeats and the compaction', () => {
  const n = normalise(session(MAIN_ID), readTranscript(mainLines()).records);
  assert.equal(n.events.length, 13);
  assert.equal(n.messages.length, 15);
  const kinds = n.events.map((e) => e.kind);
  assert.deepEqual([kinds.filter((k) => k === 'llm_call').length, kinds.filter((k) => k === 'tool_call').length], [5, 4]);
  const e = (seq: number) => n.events.find((x) => x.seq === seq)!;
  assert.deepEqual([e(2).ctx_msgs, e(2).ctx_change, e(2).ctx_exact], [2, 'fresh', true]);
  assert.deepEqual([e(5).ctx_msgs, e(5).ctx_change], [7, 'append']);
  assert.deepEqual([e(10).ctx_msgs, e(10).ctx_change], [11, 'append']);
  assert.deepEqual([e(4).status, e(6).repeat_of, e(6).repeat_visible, e(8).name, e(9).kind], ['error', 3, true, 'Agent', 'error']);
  assert.equal(e(1).duration_us, 65_000_000);
  assert.deepEqual([e(11).kind, e(11).turn, e(12).kind, e(13).ctx_change], ['user_input', 2, 'compaction', 'compact']);
  assert.deepEqual(n.contexts.filter((c) => c.seq === 13).map((c) => [c.rel, c.from_msg, c.to_msg]), [['in', 14, 14], ['in', 13, 13], ['out', 1, 11]]);
  assert.equal(n.messages.find((m) => m.msg_seq === 1)!.text, 'Fix the failing test in tests/clock_test.py 😀');
  assert.deepEqual(n.messages.filter((m) => m.kind === 'attachment').map((m) => m.msg_seq), [2]);
  assert.equal(n.toolCallSeqs.get('t4'), 8);
});

test('a transcript without a request log gets inferred contexts', () => {
  const r = readTranscript(agentLines());
  assert.equal(r.hasRequestLog, false);
  const n = normalise(session('agent-a1b2c3'), r.records);
  const e = (seq: number) => n.events.find((x) => x.seq === seq)!;
  assert.deepEqual(n.events.map((x) => x.kind), ['user_input', 'llm_call', 'tool_call', 'llm_call']);
  assert.deepEqual([e(2).ctx_msgs, e(2).ctx_exact, e(3).resource, e(4).ctx_msgs, e(4).ctx_change], [1, false, 'src', 3, 'append']);
});

test('a synthetic assistant message (a client-side API error) is an error, not a model call', () => {
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-17T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'x1', timestamp: '2026-11-17T10:00:01.000Z', isApiErrorMessage: true, requestId: 'req_x',
      message: { id: 'syn1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }], stop_reason: 'stop_sequence' } },
  ].map((r) => JSON.stringify(r));
  const r = readTranscript(lines);
  assert.deepEqual(r.records.map((x) => x.type), ['input', 'error']);
  const e = r.records[1]!;
  assert.deepEqual(e.type === 'error' ? [e.ts, e.message, e.attempt] : null, ['2026-11-17T10:00:01.000Z', "You've hit your limit", null]);
});

test('a request whose base was never answered is resolved through that base', () => {
  const h = (text: string) => apiMessageHash({ role: 'user', content: text });
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-17T10:00:00.000Z', message: { role: 'user', content: 'one' } },
    { type: 'api-request', id: 'r1', timestamp: '2026-11-17T10:00:01.000Z', base: null, keep: 0, tail: [h('one')] },
    { type: 'user', uuid: 'u2', timestamp: '2026-11-17T10:00:02.000Z', message: { role: 'user', content: 'two' } },
    { type: 'api-request', id: 'r2', timestamp: '2026-11-17T10:00:03.000Z', base: 'r1', keep: 1, tail: [h('two')] },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-11-17T10:00:04.000Z', requestRef: 'r2', requestId: 'req_2',
      message: { id: 'm1', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
  ].map((r) => JSON.stringify(r));
  const call = readTranscript(lines).records.find((x) => x.type === 'call');
  assert.deepEqual(call?.type === 'call' ? call.context : null, { request: 'r2', base: null, keep: 0, tail: [['u1'], ['u2']], exact: true });
});
