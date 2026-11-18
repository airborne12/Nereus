// A small Claude Code transcript written by hand: two turns, parallel tool calls, a failed call, a
// repeated read, a sub-agent, an API retry, a compaction, an unknown row and a malformed line.
// Request-log hashes are computed the way Claude Code computes them.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiMessageHash } from '../../src/semantics/trajectory/hash.ts';

export const MAIN_ID = 'fx-main-0001';
export const AGENT_FILE_ID = 'agent-a1b2c3';
export const AGENT_META = { agentType: 'Explore', description: 'look up clock helpers', toolUseId: 't4' };
const V = '2.1.322';
type Row = Record<string, unknown>;
const at = (hms: string) => `2026-11-17T${hms}.000Z`;

const userRow = (uuid: string, hms: string, content: unknown, extra: Row = {}): Row =>
  ({ type: 'user', uuid, timestamp: at(hms), version: V, sessionId: MAIN_ID, message: { role: 'user', content }, ...extra });
const asstRow = (msgId: string, idx: number, hms: string, item: Row, ref: string | null, stop = 'tool_use'): Row => ({
  type: 'assistant', uuid: `${msgId}-${idx}`, timestamp: at(hms), version: V, sessionId: MAIN_ID, requestId: `req_${msgId}`, requestRef: ref,
  apiBlockIndex: idx, message: { id: msgId, role: 'assistant', model: 'claude-opus-5-5', content: [item], stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } },
});
const request = (id: string, hms: string, base: string | null, keep: number, tail: string[]): Row =>
  ({ type: 'api-request', id, timestamp: at(hms), version: V, sessionId: MAIN_ID, base, keep, tail, shapeHash: 'shape1' });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Row) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error: isError });
const H = (role: string, content: unknown) => apiMessageHash({ role, content });

// Contents of the API messages, shared by the rows and the request-log hashes.
const U1 = 'Fix the failing test in tests/clock_test.py 😀';
const BLOB = [text('<system-reminder>Today is 2026-11-17.</system-reminder>')];
const M1 = [text("I'll read the test and run it."), toolUse('t1', 'Read', { file_path: 'tests/clock_test.py' }), toolUse('t2', 'Bash', { command: 'pytest tests/clock_test.py' })];
const U2 = [toolResult('t1', 'def test_clock(): assert now().tzname() == "UTC"')];
const U3 = [toolResult('t2', 'FAILED tests/clock_test.py::test_clock', true)];
const M2 = [toolUse('t3', 'Read', { file_path: 'tests/clock_test.py' })];
const U4 = [toolResult('t3', 'def test_clock(): assert now().tzname() == "UTC"')];
const M3 = [toolUse('t4', 'Agent', { description: 'look up clock helpers', prompt: 'Find the clock helpers' })];
const U5 = [toolResult('t4', 'Found src/clock.py')];
const M4 = [text('Fixed: the clock fixture now uses UTC.')];
const U6 = 'Thanks. Also keep the public API unchanged.';
const U7 = 'Summary: the clock test was fixed by using UTC.';

export function mainLines(): string[] {
  const rows: (Row | string)[] = [
    { type: 'ai-title', aiTitle: 'Fix the clock test', sessionId: MAIN_ID },
    { type: 'api-request-shape', shapeHash: 'shape1', timestamp: at('10:00:00'), version: V, sessionId: MAIN_ID,
      shape: { system: [text('You are a coding agent.')], tools: [{ name: 'Read', description: 'Read a file' }, { name: 'Bash', description: 'Run a command' }] } },
    userRow('u1', '10:00:00', U1),
    { type: 'api-request-blob', hash: H('user', BLOB), message: { role: 'user', content: BLOB }, sessionId: MAIN_ID },
    request('r1', '10:00:01', null, 0, [H('user', U1), H('user', BLOB)]),
    asstRow('m1', 0, '10:00:02', M1[0]!, 'r1'),
    asstRow('m1', 1, '10:00:03', M1[1]!, 'r1'),
    asstRow('m1', 2, '10:00:03', M1[2]!, 'r1'),
    userRow('u2', '10:00:04', U2),
    userRow('u3', '10:00:06', U3),
    request('r2', '10:00:07', 'r1', 2, [H('assistant', M1), H('user', [...U2, ...U3])]),
    asstRow('m2', 0, '10:00:09', M2[0]!, 'r2'),
    userRow('u4', '10:00:10', U4),
    request('r3', '10:00:11', 'r2', 4, [H('assistant', M2), H('user', U4)]),
    asstRow('m3', 0, '10:00:12', M3[0]!, 'r3'),
    userRow('u5', '10:01:00', U5, { toolUseResult: { agentId: 'a1b2c3' } }),
    { type: 'system', subtype: 'api_error', timestamp: at('10:01:01'), retryAttempt: 1, maxRetries: 10, retryInMs: 500, error: { message: 'Overloaded' }, sessionId: MAIN_ID },
    request('r4', '10:01:02', 'r3', 6, [H('assistant', M3), H('user', U5)]),
    asstRow('m4', 0, '10:01:05', M4[0]!, 'r4', 'end_turn'),
    { type: 'system', subtype: 'turn_duration', timestamp: at('10:01:06'), durationMs: 65000, sessionId: MAIN_ID },
    { type: 'mystery', sessionId: MAIN_ID },
    { type: 'cost-state', sessionId: MAIN_ID },
    'not json',
    userRow('u6', '12:00:00', U6),
    { type: 'system', subtype: 'compact_boundary', timestamp: at('12:00:01'), compactMetadata: { trigger: 'auto', preTokens: 5000, postTokens: 300 }, sessionId: MAIN_ID },
    userRow('u7', '12:00:02', U7, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    // The request log hashes a user row stored as a string in its item form, as Claude Code sends it.
    request('r5', '12:00:03', null, 0, [H('user', U7), H('user', [text(U6)])]),
    asstRow('m5', 0, '12:00:04', text('Noted: the public API stays unchanged.'), 'r5', 'end_turn'),
  ];
  return rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
}

/** The sub-agent: no request log, so its contexts are inferred. */
export function agentLines(): string[] {
  const row = (r: Row) => JSON.stringify({ ...r, agentId: 'a1b2c3', isSidechain: true });
  return [
    row(userRow('s1', '10:00:13', 'Find the clock helpers')),
    row(asstRow('sm1', 0, '10:00:20', toolUse('st1', 'Grep', { pattern: 'utc', path: 'src' }), null)),
    row(userRow('s2', '10:00:25', [toolResult('st1', 'src/clock.py:3: tz = utc')])),
    row(asstRow('sm2', 0, '10:00:50', text('Found src/clock.py'), null, 'end_turn')),
  ];
}

/** Writes the main file and its sub-agent folder into `dir`; returns the main file's path. */
export function writeFixture(dir: string): string {
  const sub = join(dir, MAIN_ID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const main = join(dir, `${MAIN_ID}.jsonl`);
  writeFileSync(main, `${mainLines().join('\n')}\n`);
  writeFileSync(join(sub, `${AGENT_FILE_ID}.jsonl`), `${agentLines().join('\n')}\n`);
  writeFileSync(join(sub, `${AGENT_FILE_ID}.meta.json`), JSON.stringify(AGENT_META));
  return main;
}
