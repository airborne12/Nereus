// The normaliser on synthetic capture records (spec 6.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Block, CallRecord, CaptureRecord, ContextDelta, InputRecord, Role, BlockKind, SessionRecord } from '../src/semantics/trajectory/model.ts';
import { dorisTime } from '../src/semantics/trajectory/model.ts';
import { cutUtf8, normalise, TEXT_LIMIT, toRanges } from '../src/semantics/trajectory/normalise.ts';

const S: SessionRecord = { type: 'session', id: 's1', rootId: 's1', parentId: null, spawnToolCallId: null, kind: 'main', title: null,
  agentName: null, runtime: 'test', runtimeVersion: null, startedAt: '2026-11-17T10:00:00.000Z' };
const t = (sec: number) => new Date(Date.parse('2026-11-17T10:00:00Z') + sec * 1000).toISOString();
const blk = (role: Role, kind: BlockKind, apiMsg: string, text: string, sec: number, extra: Partial<Block> = {}): Block =>
  ({ role, kind, apiMsg, text, payload: null, toolName: null, toolCallId: null, isError: null, ts: t(sec), ...extra });
const said = (apiMsg: string, text: string, sec: number) => blk('assistant', 'text', apiMsg, text, sec);
const use = (apiMsg: string, id: string, name: string, args: object, sec: number) =>
  blk('assistant', 'tool_use', apiMsg, `${name} ${JSON.stringify(args)}`, sec, { payload: args, toolName: name, toolCallId: id });
const result = (apiMsg: string, id: string, text: string, sec: number, isError = false) =>
  blk('tool', 'tool_result', apiMsg, text, sec, { toolCallId: id, isError });
const input = (b: Block, opensTurn = false): InputRecord => ({ type: 'input', block: b, opensTurn });
const ask = (apiMsg: string, text: string, sec: number) => input(blk('user', 'text', apiMsg, text, sec), true);
const call = (sec: number, blocks: Block[], context: ContextDelta | null = null, stopReason = 'tool_use'): CallRecord =>
  ({ type: 'call', blocks, requestId: null, model: 'm1', startTs: t(sec), endTs: t(sec + 1), usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    stopReason, promptHash: null, context });
const delta = (request: string, base: string | null, keep: number, tail: string[][]): ContextDelta => ({ request, base, keep, tail, exact: true });
const run = (records: CaptureRecord[]) => normalise(S, records);
const ev = (n: ReturnType<typeof run>, seq: number) => n.events.find((e) => e.seq === seq)!;
const ctx = (n: ReturnType<typeof run>, seq: number) => n.contexts.filter((c) => c.seq === seq).map((c) => [c.rel, c.pos, c.from_msg, c.to_msg]);

test('a turn with two parallel tool calls, their results and an answer (inferred contexts)', () => {
  const n = run([
    ask('u1', 'fix it', 0),
    call(1, [said('a1', 'reading', 1), use('a1', 't1', 'Read', { file_path: 'a.py' }, 1), use('a1', 't2', 'Bash', { command: 'pytest' }, 1)]),
    input(result('r1', 't1', 'print(1)', 3)),
    input(result('r2', 't2', '1 failed', 4, true)),
    call(5, [said('a2', 'done', 5)], null, 'end_turn'),
  ]);
  assert.deepEqual(n.events.map((e) => [e.seq, e.kind, e.turn, e.step]),
    [[1, 'user_input', 1, 0], [2, 'llm_call', 1, 1], [3, 'tool_call', 1, 1], [4, 'tool_call', 1, 1], [5, 'llm_call', 1, 2]]);
  assert.deepEqual([ev(n, 3).status, ev(n, 3).parent_seq, ev(n, 3).name, ev(n, 3).resource, ev(n, 3).result_msg, ev(n, 3).duration_us],
    ['ok', 2, 'Read', 'a.py', 5, 1_000_000]);
  assert.deepEqual([ev(n, 4).status, ev(n, 4).error, ev(n, 4).resource], ['error', '1 failed', 'pytest']);
  assert.deepEqual([ev(n, 2).ctx_msgs, ev(n, 2).ctx_change, ev(n, 2).ctx_exact, ev(n, 2).input_tokens, ev(n, 2).cache_read_tokens],
    [1, 'fresh', false, 1, 3]);
  assert.deepEqual([ev(n, 5).ctx_msgs, ev(n, 5).ctx_change, ev(n, 5).ctx_prefix, ev(n, 5).gap_us, ev(n, 5).stop_reason],
    [6, 'append', 1, 1_000_000, 'end_turn']);
  assert.deepEqual(ctx(n, 5), [['in', 0, 1, 6]]);
  assert.equal(n.messages.length, 7);
  assert.equal(n.messages.find((m) => m.msg_seq === 5)!.tool_name, 'Read');
  assert.equal(n.toolCallSeqs.get('t2'), 4);
});

test('the same text twice is one block; two identical tool calls are two', () => {
  const n = run([ask('u1', 'ok', 0), ask('u2', 'ok', 5),
    call(6, [use('a1', 't1', 'Read', { file_path: 'a' }, 6), use('a1', 't2', 'Read', { file_path: 'a' }, 6)])]);
  assert.deepEqual(n.events.filter((e) => e.kind === 'user_input').map((e) => e.msg_seq), [1, 1]);
  assert.equal(n.messages.filter((m) => m.kind === 'tool_use').length, 2);
});

test('logged contexts: append, truncate with dropped ranges, and an unknown base', () => {
  const n = run([
    ask('u1', 'one', 0),
    call(1, [said('c1', 'a', 1)], delta('r1', null, 0, [['u1']])),
    ask('u2', 'two', 3),
    call(4, [said('c2', 'b', 4)], delta('r2', 'r1', 1, [['c1'], ['u2']])),
    ask('u3', 'three', 6),
    call(7, [said('c3', 'c', 7)], delta('r3', 'r2', 1, [['u3']])),
    call(9, [said('c4', 'd', 9)], delta('r4', 'missing', 2, [])),
  ]);
  assert.deepEqual([ev(n, 4).ctx_change, ev(n, 4).ctx_exact, ev(n, 4).ctx_prefix], ['append', true, 1]);
  assert.deepEqual(ctx(n, 4), [['in', 0, 1, 3]]);
  assert.equal(ev(n, 6).ctx_change, 'truncate');
  assert.deepEqual(ctx(n, 6), [['in', 0, 1, 1], ['in', 1, 5, 5], ['out', 0, 2, 3]]);
  assert.deepEqual([ev(n, 7).ctx_exact, ev(n, 7).ctx_msgs], [false, 0]);
});

test('a compaction: the summary belongs to it, the next call is compact and drops the old history', () => {
  const n = run([
    ask('u1', 'start', 0),
    call(1, [said('a1', 'ok', 1)]),
    { type: 'compaction', ts: t(3), trigger: 'auto', preTokens: 100, postTokens: 10 },
    input(blk('user', 'summary', 'sum', 'Summary: started', 4)),
    ask('u2', 'go on', 5),
    call(6, [said('a2', 'going', 6)]),
  ]);
  assert.deepEqual([ev(n, 3).kind, ev(n, 3).attrs], ['compaction', { trigger: 'auto', pre_tokens: 100, post_tokens: 10 }]);
  assert.equal(n.messages.find((m) => m.kind === 'summary')!.event_seq, 3);
  assert.deepEqual([ev(n, 5).ctx_change, ev(n, 5).ctx_msgs, ev(n, 4).turn], ['compact', 2, 2]);
  assert.deepEqual(ctx(n, 5), [['in', 0, 3, 4], ['out', 0, 1, 1]]);
});

test('repeats: the same arguments again, with the first result in context or not', () => {
  const read = { file_path: 'a' };
  const n = run([
    ask('u1', 'go', 0),
    call(1, [use('c1', 't1', 'Read', read, 1)], delta('r1', null, 0, [['u1']])),
    input(result('res1', 't1', 'text of a', 2)),
    call(3, [use('c2', 't2', 'Read', read, 3)], delta('r2', 'r1', 1, [['c1'], ['res1']])),
    input(result('res2', 't2', 'text of a', 4)),
    call(5, [use('c3', 't3', 'Read', read, 5)], delta('r3', 'r2', 1, [])),
  ]);
  assert.deepEqual([3, 5, 7].map((s) => [ev(n, s).repeat_of, ev(n, s).repeat_visible]), [[null, null], [3, true], [3, false]]);
});

test('an open call, an orphan result, a retry, a turn end, a prompt and an over-long text', () => {
  const n = run([
    ask('u1', 'go', 0),
    call(1, [use('c1', 't1', 'Read', { file_path: 'x' }, 1)]),
    input(result('rz', 'nope', 'orphan', 2)),
    { type: 'error', ts: t(3), message: 'Overloaded', attempt: 1, maxAttempts: 10, retryInMs: 500 },
    { type: 'turn_end', ts: t(4), durationMs: 4000 },
    { type: 'prompt', hash: 'p1', system: 'You are an agent.', tools: [{ name: 'Read' }, { name: 'Bash' }], ts: t(0) },
    input(blk('user', 'attachment', 'big', `${'x'.repeat(TEXT_LIMIT)}😀`, 5)),
  ]);
  assert.equal(ev(n, 3).status, '', 'a call without a result stays open');
  assert.equal(n.messages.find((m) => m.text === 'orphan')!.event_seq, null);
  assert.deepEqual([ev(n, 4).kind, ev(n, 4).status, ev(n, 4).attempt, ev(n, 4).attrs], ['error', 'error', 1, { max_attempts: 10, retry_in_ms: 500 }]);
  assert.deepEqual([ev(n, 1).end_ts, ev(n, 1).duration_us], [dorisTime(t(4)), 4_000_000]);
  assert.deepEqual(n.prompts.map((p) => [p.prompt_hash, p.tool_names, p.system_text]), [['p1', ['Read', 'Bash'], 'You are an agent.']]);
  const big = n.messages.find((m) => m.kind === 'attachment')!;
  assert.deepEqual([big.truncated, Buffer.byteLength(big.text), big.bytes], [true, TEXT_LIMIT, TEXT_LIMIT + 4]);
});

test('cutUtf8 cuts on a character boundary; toRanges keeps list order', () => {
  assert.deepEqual(cutUtf8('ab😀', 4), { text: 'ab', cut: true });
  assert.deepEqual(cutUtf8('ab', 4), { text: 'ab', cut: false });
  assert.deepEqual(toRanges([1, 2, 3, 7, 8, 5]), [{ from: 1, to: 3 }, { from: 7, to: 8 }, { from: 5, to: 5 }]);
});

test('a context built on an unknown base or an unresolved message stays inexact in later calls', () => {
  const n = run([
    ask('u1', 'one', 0),
    call(1, [said('c1', 'a', 1)], delta('r1', 'earlier', 2, [['u1']])),
    ask('u2', 'two', 3),
    call(4, [said('c2', 'b', 4)], delta('r2', 'r1', 3, [['c1'], ['u2']])),
    call(6, [said('c3', 'c', 6)], { request: 'r3', base: null, keep: 0, tail: [null, ['u2']], exact: false }),
    call(8, [said('c4', 'd', 8)], delta('r4', 'r3', 2, [['c3']])),
  ]);
  assert.deepEqual([2, 4, 5, 6].map((s) => ev(n, s).ctx_exact), [false, false, false, false]);
});
