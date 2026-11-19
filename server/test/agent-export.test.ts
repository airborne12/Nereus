// Exports: CSV fields, and conversations assembled from block rows (no database).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chat, conversationSql, conversations, exportName, toCsv } from '../src/semantics/trajectory/export.ts';

test('CSV: quotes, line breaks, empty values and objects', () => {
  assert.equal(toCsv(['a', 'b', 'c'], [{ a: 'x,y', b: 'say "hi"\nthere', c: null }, { a: 1, b: { k: 1 } }]),
    'a,b,c\n"x,y","say ""hi""\nthere",\n1,"{""k"":1}",\n');
});

const b = (msg_seq: number, msg_role: string, kind: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ session_id: 's', part: 1, msg_seq, api_msg: msg_seq, msg_role, kind, text, tool_name: null, tool_call_id: null, is_error: null, payload: null, ...extra });

test('chat: one assistant message per API message with its calls; tool results; summaries; no thinking', () => {
  const blocks = [
    b(1, 'user', 'text', 'fix it'),
    b(2, 'assistant', 'thinking', 'hmm', { api_msg: 9 }),
    b(3, 'assistant', 'text', 'reading', { api_msg: 9 }),
    b(4, 'assistant', 'tool_use', 'Read {}', { api_msg: 9, tool_name: 'Read', tool_call_id: 't1', payload: '{"file_path":"a"}' }),
    b(5, 'tool', 'tool_result', 'text of a', { tool_name: 'Read', tool_call_id: 't1', is_error: 0 }),
    b(6, 'user', 'summary', 'so far'),
    b(7, 'assistant', 'tool_use', 'Bash {}', { tool_name: 'Bash', tool_call_id: 't2', payload: { command: 'ls' } }),
  ];
  assert.deepEqual(chat(blocks), [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: 'reading', tool_calls: [{ id: 't1', name: 'Read', arguments: { file_path: 'a' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'Read', is_error: false, content: 'text of a' },
    { role: 'user', summary: true, content: 'so far' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't2', name: 'Bash', arguments: { command: 'ls' } }] },
  ]);
});

test('conversations: the system prompt first, a repeated block once, parts without an answer left out', () => {
  const parts = [
    { session_id: 's', part: 1, root_id: 's', parent_id: null, kind: 'main', agent_name: null, model: 'm', title: 't', system_text: 'You are an agent.' },
    { session_id: 's', part: 2, root_id: 's', parent_id: null, kind: 'main', agent_name: null, model: 'm', title: 't', system_text: null },
  ];
  const blocks = [b(1, 'user', 'text', 'go'), b(2, 'assistant', 'text', 'ok'), b(2, 'assistant', 'text', 'ok'), { ...b(3, 'user', 'text', 'more'), part: 2 }];
  const lines = conversations(parts, blocks);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0]!.messages, [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }]);
  assert.equal(conversations(parts, blocks, 2)[0]!.messages.length, 2);
});

test('statements: a part is the context of its last model call plus that call output', () => {
  const s = conversationSql('otel', { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z', q: 'clock', conditions: [], limit: 100, offset: 0 }, true);
  assert.match(s.blocks.sql, /sum\(if\(kind = 'compaction', 1, 0\)\) OVER \(PARTITION BY session_id ORDER BY seq\) \+ 1 AS part/);
  assert.match(s.blocks.sql, /JOIN otel\.agent_contexts c ON c\.session_id = l\.session_id AND c\.seq = l\.seq AND c\.rel = 'in'/);
  assert.match(s.blocks.sql, /e\.seq = l\.seq OR e\.parent_seq = l\.seq/);
  assert.match(s.blocks.sql, /ORDER BY session_id, part, src, pos, msg_seq$/);
  assert.match(s.size.sql, /ORDER BY s\.last_event_at DESC LIMIT 3\) r/);
  assert.match(s.size.sql, /s\.title MATCH_PHRASE 'clock'/);
});

test('export file names carry the page and the time', () => {
  assert.equal(exportName('steps', 'csv', new Date('2026-11-18T09:05:01Z')), 'agent-steps-20261118090501.csv');
});

test('conversations: a part of 30000 blocks, each listed twice, de-duplicates in linear time', () => {
  const parts = [{ session_id: 's', part: 1, root_id: 's', parent_id: null, kind: 'main', agent_name: null, model: 'm', title: 't', system_text: null }];
  const blocks: Record<string, unknown>[] = [];
  for (let seq = 1; seq <= 15_000; seq++) {
    const block = b(seq, seq % 2 ? 'user' : 'assistant', 'text', `m${seq}`);
    blocks.push(block, { ...block });
  }
  const start = performance.now();
  const lines = conversations(parts, blocks);
  const elapsed = performance.now() - start;
  assert.equal(lines[0]!.messages.length, 15_000);
  assert.equal(lines[0]!.messages.some((m) => m.role === 'system'), false);
  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
});

test('CSV: free text a spreadsheet would run as a formula gets a leading apostrophe; other columns stay raw', () => {
  const rows = [{ t: '=1+1', n: -5 }, { t: '@x', n: 1 }, { t: '+1,2', n: 2 }, { t: '-rf', n: 3 }, { t: '\tx', n: 4 }, { t: 'a = b', n: 5 }];
  assert.equal(toCsv(['t', 'n'], rows, new Set(['t'])), "t,n\n'=1+1,-5\n'@x,1\n\"'+1,2\",2\n'-rf,3\n'\tx,4\na = b,5\n");
  assert.equal(toCsv(['t'], [{ t: '=1+1' }]), 't\n=1+1\n');
});
