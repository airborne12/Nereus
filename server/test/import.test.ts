// Finding transcript files and reading a session with its sub-agents (no database).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cursorOf, findTranscripts, readTree } from '../src/cli/import-transcripts.ts';
import { AGENT_FILE_ID, MAIN_ID, writeFixture } from './fixtures/claude-transcript.ts';

function withFixture(fn: (dir: string, main: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nereus-import-'));
    try { await fn(dir, writeFixture(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test('findTranscripts lists main session files, never sub-agent files', withFixture(async (dir, main) => {
  writeFileSync(join(dir, 'notes.txt'), 'x');
  assert.deepEqual(await findTranscripts([dir]), [main]);
  assert.deepEqual(await findTranscripts([main]), [main]);
}));

test('readTree links a sub-agent to the call that spawned it', withFixture(async (_dir, main) => {
  const tree = await readTree(main);
  assert.deepEqual(tree.branches.map((b) => [b.record.id, b.record.kind, b.record.parentId, b.parentSeq]),
    [[MAIN_ID, 'main', null, null], [AGENT_FILE_ID, 'subagent', MAIN_ID, 8]]);
  const sub = tree.branches[1]!.record;
  assert.deepEqual([sub.rootId, sub.agentName, sub.title], [MAIN_ID, 'Explore', 'look up clock helpers']);
  assert.equal(tree.branches[0]!.record.title, 'Fix the clock test');
  assert.deepEqual([tree.normalised.length, tree.malformed, tree.unresolved, tree.skipped], [2, 1, 0, { mystery: 1 }]);
}));

test('a sub-agent without its meta file is kept under the main session', withFixture(async (dir, main) => {
  rmSync(join(dir, MAIN_ID, 'subagents', `${AGENT_FILE_ID}.meta.json`));
  const sub = (await readTree(main)).branches[1]!;
  assert.deepEqual([sub.record.parentId, sub.parentSeq, sub.record.agentName], [MAIN_ID, null, null]);
}));

test('the cursor is the size and modification time of the file', withFixture(async (_dir, main) => {
  const c = JSON.parse(await cursorOf(main)) as { bytes: number; mtimeMs: number };
  assert.ok(c.bytes > 0 && c.mtimeMs > 0);
}));
