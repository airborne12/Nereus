// Batching, labels and the Stream Load response handling, with a stub in place of Doris.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StreamLoadError, streamLoad } from '../src/db/stream-load.ts';
import { batches, labelFor, writeBranch } from '../src/semantics/ingest/writer.ts';
import { readTranscript } from '../src/semantics/adapters/claude-transcript.ts';
import { normalise } from '../src/semantics/trajectory/normalise.ts';
import { MAIN_ID, mainLines } from './fixtures/claude-transcript.ts';

test('batches respect the row and byte caps and keep order', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ i, text: 'x'.repeat(10) }));
  assert.deepEqual(batches(rows, 3, 1_000_000).map((b) => b.map((r) => r.i)), [[0, 1, 2], [3, 4, 5], [6]]);
  const size = JSON.stringify(rows[0]).length + 1;
  assert.deepEqual(batches(rows, 100, size * 2).map((b) => b.length), [2, 2, 2, 1]);
  assert.deepEqual(batches([{ big: 'y'.repeat(50) }], 100, 10).map((b) => b.length), [1], 'a row over the cap goes alone');
  assert.deepEqual(batches([], 3, 10), []);
});

test('labels are valid Doris labels and change with the content', () => {
  const a = labelFor('agent_events', 'agent-a1b2c3', 0, [{ seq: 1 }]);
  assert.match(a, /^agent_events_[0-9a-f]{40}$/);
  assert.equal(a, labelFor('agent_events', 'agent-a1b2c3', 0, [{ seq: 1 }]));
  assert.notEqual(a, labelFor('agent_events', 'agent-a1b2c3', 0, [{ seq: 2 }]));
  assert.notEqual(a, labelFor('agent_events', 'agent-a1b2c3', 1, [{ seq: 1 }]));
});

test('streamLoad: success, a label loaded before, and a failure', async () => {
  const cfg = { url: 'http://be:8040', user: 'u', password: 'p' };
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const answer = (body: object) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  assert.equal(await streamLoad(cfg, 'db', 'agent_events', 'agent_events_x', [{ a: 1 }, { a: '😀' }], answer({ Status: 'Success' })), 'loaded');
  assert.equal(calls[0]!.url, 'http://be:8040/api/db/agent_events/_stream_load');
  assert.equal(calls[0]!.body, '{"a":1}\n{"a":"😀"}\n');
  assert.equal(calls[0]!.headers.label, 'agent_events_x');
  assert.equal(calls[0]!.headers.format, 'json');
  assert.equal(await streamLoad(cfg, 'db', 't', 'l', [{}], answer({ Status: 'Label Already Exists', ExistingJobStatus: 'FINISHED' })), 'already-loaded');
  await assert.rejects(streamLoad(cfg, 'db', 't', 'l', [{}], answer({ Status: 'Fail', Message: 'too many filtered rows' })), StreamLoadError);
  await assert.rejects(streamLoad(cfg, 'db', 't', 'bad label!', [{}], answer({ Status: 'Success' })), /label/);
});

test('writeBranch loads every table of a branch in batches', async () => {
  const n = normalise({ type: 'session', id: MAIN_ID, rootId: MAIN_ID, parentId: null, spawnToolCallId: null, kind: 'main', title: null,
    agentName: null, runtime: 'claude-code', runtimeVersion: null, startedAt: '2026-11-17T10:00:00.000Z' }, readTranscript(mainLines()).records);
  const loads: { table: string; n: number }[] = [];
  const report = await writeBranch(async (table, _label, rows) => { loads.push({ table, n: rows.length }); return 'loaded'; }, n);
  assert.deepEqual(loads.map((l) => l.table), ['agent_prompts', 'agent_messages', 'agent_events', 'agent_contexts']);
  assert.deepEqual(report.map((r) => [r.table, r.rows]), [['agent_prompts', 1], ['agent_messages', 15], ['agent_events', 13], ['agent_contexts', n.contexts.length]]);
});
