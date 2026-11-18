// Session totals: the SQL that computes them and the session rows made from them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Branch, type BranchTotals, sessionRows, totalsFromRows, totalsSql } from '../src/semantics/ingest/totals.ts';
import type { SessionRecord } from '../src/semantics/trajectory/model.ts';

const rec = (id: string, kind: 'main' | 'subagent', parentId: string | null): SessionRecord => ({ type: 'session', id, rootId: 'm', parentId,
  spawnToolCallId: null, kind, title: `title ${id}`, agentName: kind === 'main' ? null : 'Explore', runtime: 'claude-code', runtimeVersion: '2.1.322',
  startedAt: '2026-11-17T10:00:00.000Z' });
const tot = (o: Partial<BranchTotals>): BranchTotals => ({ turns: 1, steps: 1, tool_calls: 0, tool_errors: 0, compactions: 0, input_tokens: 0,
  output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, peak_ctx_tokens: 0, started_at: '2026-11-17 10:00:00.000000',
  last_event_at: '2026-11-17 10:00:10.000000', idle_us: 0, last_seq: 1, last_msg_seq: 1, model: 'm1', first_input: 'hi', last_output: 'bye', ...o });

test('totalsSql filters the branches and aggregates in Doris', () => {
  const sql = totalsSql('otel', ['m', "o'neil"]);
  assert.match(sql, /FROM otel\.agent_events WHERE session_id IN \('m', 'o\\'neil'\)/);
  assert.match(sql, /sum\(if\(kind = 'tool_call' AND status = 'error', 1, 0\)\) AS tool_errors/);
  assert.match(sql, /max_by\(text, if\(msg_role = 'assistant' AND kind = 'text', msg_seq, NULL\)\) AS last_output/);
  assert.throws(() => totalsSql('otel', []), /no session/);
});

test('totalsFromRows turns Doris strings into numbers', () => {
  const t = totalsFromRows([{ session_id: 'm', turns: '2', steps: '5', tool_calls: '4', tool_errors: '1', compactions: '1', input_tokens: '50',
    output_tokens: '100', cache_read_tokens: '500', cache_write_tokens: '25', peak_ctx_tokens: '115', started_at: '2026-11-17 10:00:00.000000',
    last_event_at: '2026-11-17 12:00:04.000000', idle_us: '7134000000', last_seq: '13', last_msg_seq: '15', model: 'claude-opus-5-5',
    first_input: 'Fix', last_output: 'Noted' }]).get('m')!;
  assert.deepEqual([t.turns, t.steps, t.idle_us, t.last_seq, t.model], [2, 5, 7134000000, 13, 'claude-opus-5-5']);
});

test('a main row adds up its tree; a sub-agent row keeps its own; the cursor is on the main row only', () => {
  const branches: Branch[] = [{ record: rec('m', 'main', null), parentSeq: null }, { record: rec('a', 'subagent', 'm'), parentSeq: 8 }];
  const totals = new Map([
    ['m', tot({ turns: 2, steps: 5, tool_calls: 4, tool_errors: 1, peak_ctx_tokens: 115, idle_us: 2_000_000, last_event_at: '2026-11-17 10:00:20.000000' })],
    ['a', tot({ steps: 2, tool_calls: 1, peak_ctx_tokens: 300, last_event_at: '2026-11-17 10:00:50.000000' })],
  ]);
  const [m, a] = sessionRows(branches, totals, '{"bytes":10}');
  assert.deepEqual([m!.steps, m!.tool_calls, m!.tool_errors, m!.subagents, m!.turns, m!.peak_ctx_tokens, m!.last_event_at],
    [7, 5, 1, 1, 2, 300, '2026-11-17 10:00:50.000000']);
  assert.equal(m!.active_us, 50_000_000 - 2_000_000);
  assert.deepEqual([m!.source_cursor, a!.source_cursor, m!.root_id, a!.parent_id, a!.parent_seq, a!.kind, a!.agent_name],
    ['{"bytes":10}', null, 'm', 'm', 8, 'subagent', 'Explore']);
  assert.deepEqual([a!.steps, a!.subagents, a!.turns], [2, 0, 1]);
  assert.equal(m!.safety_risks, null);
});

test('a branch with no events still gets a row', () => {
  const [row] = sessionRows([{ record: rec('m', 'main', null), parentSeq: null }], new Map(), 'c');
  assert.deepEqual([row!.steps, row!.last_seq, row!.started_at, row!.last_event_at], [0, 0, '2026-11-17 10:00:00.000000', '2026-11-17 10:00:00.000000']);
});
