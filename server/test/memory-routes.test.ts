// The memory routes with a stub in place of Doris: the Memories table, one memory with its fields,
// sections, versions, the calls that used it and its state, and an address that names no memory.

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { agentRoutes } from '../src/api/agents/routes.ts';
import type { Doris } from '../src/db/doris.ts';

const VERSION = {
  captured_at: '2026-11-19 10:00:00', updated_at: '2026-11-11 00:17:09', format: 'claude-auto-memory', location: '/home/u/.claude/projects/-home-u/memory/build.md',
  description: 'Keep the cache', kind: 'feedback', content: 'Run make with --keep.\n\n## Why\nForty minutes.',
  sections: '[{"heading":null,"text":"Run make with --keep."},{"heading":"Why","text":"Forty minutes."}]', fields: '{"name":"build","metadata":{"type":"feedback"}}',
  content_hash: 'h2', source_session_id: 's-1', source_kind: 'recorded', source_score: null, source_root_id: 's-1', source_title: 'Speed up the build',
};

function stub(versions: Record<string, unknown>[], uses: Record<string, unknown>[] = [], history: Record<string, unknown>[] = []) {
  const seen: string[] = [];
  const doris = {
    query: async (sql: string) => {
      seen.push(sql);
      if (sql.startsWith('SELECT count(*)')) return [{ total: versions.length, bytes: 0 }];
      if (sql.includes('FROM otel.agent_memories m\nLEFT JOIN')) return versions;
      if (sql.startsWith('SELECT e.session_id, s.root_id')) return uses;
      if (sql.startsWith('SELECT j.version')) return history;
      return versions;
    },
  } as unknown as Doris;
  return { doris, seen };
}

function call(doris: Doris, path: string) {
  const answers: { status: number; body: any }[] = [];
  const routes = agentRoutes({ doris, db: 'otel', send: (_res, status, body) => answers.push({ status, body }) });
  const res = { writeHead: () => res, end: () => undefined } as unknown as ServerResponse;
  return { done: routes.handle({ method: 'GET' } as IncomingMessage, res, new URL(`http://x${path}`)), answers };
}

test('the Memories table is a table page like the others', async () => {
  const { doris, seen } = stub([{ name: 'build' }]);
  const c = call(doris, '/api/agents/memories?from=2026-11-01T00:00:00Z&to=2026-11-20T00:00:00Z');
  await c.done;
  assert.deepEqual([c.answers[0]!.status, c.answers[0]!.body.total, c.answers[0]!.body.sql.map((s: any) => s.title)], [200, 1, ['Rows', 'Total']]);
  assert.ok(c.answers[0]!.body.columns.some((x: any) => x.name === 'still_valid'));
  assert.match(seen[0]!, /FROM \(SELECT agent, scope, name, max\(captured_at\)/);
});

test('one memory: its latest version with fields and sections, its versions, the calls that used it, and its state', async () => {
  const older = { ...VERSION, captured_at: '2026-11-12 09:00:00', content_hash: 'h1' };
  const uses = [{ session_id: 'agent-a1', root_id: 's-2', title: 'Clean build', seq: 31, parent_seq: 30, ts: '2026-11-15 10:00:00', turn: 2, step: 4, name: 'Read' }];
  const { doris } = stub([VERSION, older], uses);
  const c = call(doris, `/api/agents/memories/claude-code/${encodeURIComponent('-home-u')}/build`);
  await c.done;
  const b = c.answers[0]!.body;
  assert.equal(c.answers[0]!.status, 200);
  assert.deepEqual([b.memory.name, b.memory.kind, b.memory.fields, b.memory.sections.length, b.memory.source_title], ['build', 'feedback', { name: 'build', metadata: { type: 'feedback' } }, 2, 'Speed up the build']);
  assert.deepEqual([b.versions.length, b.versions[1].content_hash, b.uses, b.history, b.state], [2, 'h1', uses, [], 'unjudged']);
  assert.deepEqual(b.sql.map((s: any) => s.title), ['Versions of the memory', 'Calls that read or wrote it', 'States of the memory']);
  const judged = call(stub([VERSION], uses, [{ version: 1, state: 'doubt', evidence: 'conflicts', reason: 'Another flag.' }]).doris, `/api/agents/memories/claude-code/${encodeURIComponent('-home-u')}/build`);
  await judged.done;
  assert.deepEqual([judged.answers[0]!.body.state, judged.answers[0]!.body.history.length], ['doubt', 1]);
  const late = call(stub([VERSION, { ...older, captured_at: '2026-11-16 00:00:00' }], uses).doris, `/api/agents/memories/claude-code/${encodeURIComponent('-home-u')}/build`);
  await late.done;
  assert.equal(late.answers[0]!.body.state, 'unused', 'a read before the capture that still saw the version before does not count');
  assert.equal(b.versions[0].content, undefined, 'the versions list carries no content');
});

test('an address that names no memory is not found; one that is not encoded well is refused', async () => {
  const none = call(stub([]).doris, '/api/agents/memories/claude-code/p/none');
  await none.done;
  assert.deepEqual([none.answers[0]!.status, none.answers[0]!.body], [404, { error: 'no such memory' }]);
  await assert.rejects(call(stub([]).doris, '/api/agents/memories/claude-code/%E0%A4%A/x').done, /not a memory address/);
});
