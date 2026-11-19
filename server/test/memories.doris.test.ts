// Memories on a live Doris and PostgreSQL: a capture writes a version of each memory and infers the
// source of one whose agent did not record it (spec 12, item 9); an unchanged memory writes nothing,
// an edited one a new version, a removed one a row that says so; the Memories table, one memory and
// the memories a session wrote read the result. Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importFile } from '../src/cli/import-transcripts.ts';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../src/db/stream-load.ts';
import { Leases } from '../src/jobs/leases.ts';
import { type CaptureDeps, captureStores, type MemoryStore } from '../src/jobs/memories.ts';
import { readClaudeMemory } from '../src/semantics/memories/claude-memory.ts';
import { readGeminiMemories } from '../src/semantics/memories/gemini-memory.ts';
import { memoriesPage, memorySql, memoryState, wroteSql } from '../src/semantics/memories/pages.ts';
import { tableSql } from '../src/semantics/trajectory/query.ts';
import { BUILD_MEMORY, MEMORY_DIR, READER_ID, WRITER_ID, writeMemorySessions } from './fixtures/memory-transcript.ts';
import { freshMetaDb } from './meta-helper.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_memories_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let doris: Doris;
let deps: CaptureDeps;
let dir = '';
let close: () => Promise<void> = async () => {};

const BUILD = [
  '---', 'name: build-cache-flag', 'description: The build reuses its cache only with the keep flag', 'metadata:', '  type: feedback',
  `  originSessionId: ${WRITER_ID}`, '  modified: 2026-11-17T12:00:30.000Z', '---', 'Run make with --keep to reuse the cache.',
].join('\n');
const STAGING = 'The staging deploy pipeline waits for the artifact registry mirror, and uploads again after each timeout.';
const UNRELATED = 'Quarterly invoices go to the finance mailbox before the fifth working day.';
const LATER = Date.parse('2026-11-18T09:00:00Z');

/** The two stores as the adapters read them: three Claude Code memories, or the ones given, and two Gemini CLI bullets. */
function stores(claude: [string, string][] = [['build-cache-flag', BUILD], ['staging-deploy', STAGING], ['unrelated-note', UNRELATED]]): MemoryStore[] {
  return [
    { agent: 'claude-code', scope: '-home-u-work', memories: claude.map(([n, text]) => readClaudeMemory(`${MEMORY_DIR}/${n}.md`, text, LATER)!) },
    { agent: 'gemini-cli', scope: 'global', memories: readGeminiMemories('/home/u/.gemini/GEMINI.md', '## Gemini Added Memories\n- Use pnpm here.\n- Fridays are read-only.\n', 'global', LATER) },
  ];
}

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  // The clean-up is set first, so that a set-up that fails does not leave the connection open.
  let drop = async () => {};
  close = async () => {
    await drop();
    try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
  };
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-memories-'));
  for (const file of writeMemorySessions(dir)) await importFile(file, { doris, db, load });
  const meta = await freshMetaDb();
  drop = () => meta.drop();
  deps = { doris, db, load, leases: new Leases(meta.pool), now: () => new Date('2026-11-19T10:00:00Z') };
});
after(async () => {
  await close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const versions = async () => doris.query(`SELECT name, source_kind, source_session_id, source_score, content_hash FROM ${db}.agent_memories ORDER BY name, captured_at`);

test('a capture writes every memory, keeps a recorded source and infers one from the words of a session', { skip: !enabled }, async () => {
  assert.deepEqual(await captureStores(deps, stores()), { stores: 2, written: 5, removed: 0, unchanged: 0, inferred: 1, held: 0, failed: [] });
  const rows = Object.fromEntries((await versions()).map((r) => [String(r.name), [r.source_kind, r.source_session_id]]));
  assert.deepEqual(rows, {
    'build-cache-flag': ['recorded', WRITER_ID], 'staging-deploy': ['inferred', READER_ID], 'unrelated-note': ['none', null],
    'Use pnpm here.': ['none', null], 'Fridays are read-only.': ['none', null],
  });
  const staging = (await versions()).find((r) => r.name === 'staging-deploy')!;
  assert.ok(Number(staging.source_score) > 0.5 && Number(staging.source_score) <= 1, String(staging.source_score));
});

test('an unchanged memory writes nothing; an edited one a new version; a removed one a row that says so', { skip: !enabled }, async () => {
  assert.deepEqual(await captureStores(deps, stores()), { stores: 2, written: 0, removed: 0, unchanged: 5, inferred: 0, held: 0, failed: [] });
  deps = { ...deps, now: () => new Date('2026-11-19T11:00:00Z') };
  const edited = await captureStores(deps, stores([['build-cache-flag', BUILD], ['staging-deploy', `${STAGING} Ask before a rebuild.`]]));
  assert.deepEqual([edited.written, edited.removed, edited.unchanged], [1, 1, 3]);
  const names = (await versions()).map((r) => `${String(r.name)}:${String(r.content_hash).length === 64 ? 'v' : String(r.content_hash)}`);
  assert.deepEqual(names.filter((n) => n.startsWith('staging') || n.startsWith('unrelated')), ['staging-deploy:v', 'staging-deploy:v', 'unrelated-note:v', 'unrelated-note:removed']);
});

test('the Memories table shows the latest version of each memory still kept, and whether a session used it since', { skip: !enabled }, async () => {
  const { rows } = tableSql(memoriesPage(db), { from: '2026-11-01T00:00:00Z', to: '2026-11-20T00:00:00Z', q: '', conditions: [], limit: 100, offset: 0 }, 'list');
  const shown = Object.fromEntries((await doris.query(rows.sql)).map((r) => [String(r.name), [r.still_valid, r.source_kind, r.source_root_id]]));
  assert.deepEqual(shown, {
    'build-cache-flag': ['unjudged', 'recorded', WRITER_ID], 'staging-deploy': ['unused', 'inferred', READER_ID],
    'Use pnpm here.': ['unrecorded', 'none', null], 'Fridays are read-only.': ['unrecorded', 'none', null],
  });
  const found = tableSql(memoriesPage(db), { from: '2026-11-01T00:00:00Z', to: '2026-11-20T00:00:00Z', q: 'artifact registry', conditions: [], limit: 100, offset: 0 }, 'list');
  assert.deepEqual((await doris.query(found.rows.sql)).map((r) => r.name), ['staging-deploy']);
});

test('one memory: its versions and the calls that wrote and read its file; the session that wrote it', { skip: !enabled }, async () => {
  const s = memorySql(db, { agent: 'claude-code', scope: '-home-u-work', name: 'build-cache-flag' });
  const [v, uses] = [await doris.query(s.versions.sql), await doris.query(s.uses.sql)];
  assert.deepEqual([v.length, v[0]!.location, v[0]!.source_title], [1, BUILD_MEMORY, 'Remember the keep flag']);
  assert.deepEqual(uses.map((u) => [u.session_id, u.name]), [[READER_ID, 'Read'], [WRITER_ID, 'Write']]);
  assert.equal(memoryState(v[0]!, uses), 'unjudged');
  assert.deepEqual((await doris.query(wroteSql(db, [WRITER_ID]).sql)).map((r) => r.name), ['build-cache-flag']);
  assert.deepEqual(await doris.query(wroteSql(db, [READER_ID]).sql), [], 'reading a memory, or being its inferred source, is not writing it');
});
