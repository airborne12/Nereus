// Imports Claude Code transcripts into the agent tables.
//
//   node src/cli/import-transcripts.ts [--force] <dir-or-file>...
//
// A directory is searched two levels deep for <session>.jsonl files; each session's sub-agents are
// read from <session>/subagents/. A file whose size and modification time match the stored cursor
// is skipped unless --force is given. Doris is reached through DORIS_HOST, DORIS_PORT, DORIS_USER,
// DORIS_PASSWORD, DORIS_DB and DORIS_BE_HTTP_URL.

import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { escape } from 'mysql2';
import { Doris, configFromEnv } from '../db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { readTranscript, type TranscriptResult } from '../semantics/adapters/claude-transcript.ts';
import { type Branch, sessionRows, totalsFromRows, totalsSql } from '../semantics/ingest/totals.ts';
import { batches, labelFor, type Load, writeBranch } from '../semantics/ingest/writer.ts';
import type { Normalised, SessionRecord } from '../semantics/trajectory/model.ts';
import { normalise } from '../semantics/trajectory/normalise.ts';

export interface Tree { branches: Branch[]; normalised: Normalised[]; skipped: Record<string, number>; malformed: number; unresolved: number }
export interface ImportReport {
  session: string; status: 'imported' | 'unchanged'; branches: number; events: number; messages: number;
  skipped: Record<string, number>; malformed: number; unresolved: number;
}

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

export async function findTranscripts(paths: readonly string[], depth = 2): Promise<string[]> {
  const found: string[] = [];
  for (const p of paths) {
    if (!(await isDir(p))) {
      if (p.endsWith('.jsonl')) found.push(p);
      continue;
    }
    const names = (await readdir(p)).sort();
    found.push(...names.filter((n) => n.endsWith('.jsonl')).map((n) => join(p, n)));
    if (depth > 1) {
      const dirs = names.filter((n) => n !== 'subagents').map((n) => join(p, n));
      for (const d of dirs) if (await isDir(d)) found.push(...(await findTranscripts([d], depth - 1)));
    }
  }
  return found;
}

export async function cursorOf(file: string): Promise<string> {
  const s = await stat(file);
  return JSON.stringify({ bytes: s.size, mtimeMs: Math.trunc(s.mtimeMs) });
}

const readLines = async (file: string) => (await readFile(file, 'utf8')).split('\n');
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function record(id: string, rootId: string, r: TranscriptResult, extra: Partial<SessionRecord>): SessionRecord {
  return { type: 'session', id, rootId, parentId: null, spawnToolCallId: null, kind: 'main', title: r.title, agentName: null,
    runtime: 'claude-code', runtimeVersion: r.runtimeVersion, startedAt: r.startedAt ?? new Date(0).toISOString(), ...extra };
}

export async function readTree(file: string): Promise<Tree> {
  const id = basename(file, '.jsonl');
  const main = readTranscript(await readLines(file));
  const read: { result: TranscriptResult; record: SessionRecord }[] = [{ result: main, record: record(id, id, main, {}) }];
  const subDir = join(dirname(file), id, 'subagents');
  const subFiles = (await readdir(subDir).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl')).sort();
  for (const f of subFiles) {
    const meta = JSON.parse(await readFile(join(subDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8').catch(() => '{}')) as Record<string, unknown>;
    const result = readTranscript(await readLines(join(subDir, f)));
    read.push({ result, record: record(basename(f, '.jsonl'), id, result, {
      kind: 'subagent', parentId: id, spawnToolCallId: str(meta.toolUseId), agentName: str(meta.agentType),
      title: str(meta.description) ?? result.title, startedAt: result.startedAt ?? main.startedAt ?? new Date(0).toISOString(),
    }) });
  }
  const normalised = read.map((x) => normalise(x.record, x.result.records));
  // A branch's parent is the branch that issued the tool call that spawned it; failing that, the main session.
  const branches = normalised.map((n): Branch => {
    const spawn = n.session.spawnToolCallId;
    const parent = spawn ? normalised.find((p) => p.toolCallSeqs.has(spawn)) : undefined;
    if (n.session.kind === 'main') return { record: n.session, parentSeq: null };
    return { record: { ...n.session, parentId: parent?.session.id ?? id }, parentSeq: parent && spawn ? parent.toolCallSeqs.get(spawn)! : null };
  });
  const skipped: Record<string, number> = {};
  for (const x of read) for (const [k, v] of Object.entries(x.result.skipped)) skipped[k] = (skipped[k] ?? 0) + v;
  return { branches, normalised: normalised.map((n, i) => ({ ...n, session: branches[i]!.record })), skipped,
    malformed: read.reduce((a, x) => a + x.result.malformed, 0), unresolved: read.reduce((a, x) => a + x.result.unresolved, 0) };
}

/**
 * Deletes the stored rows of a session tree before it is written again, so that rows the transcript
 * no longer produces (renumbered or dropped) do not stay. The session rows go too, so an import that
 * fails part-way is redone by the next run. Prompts are shared between sessions and kept.
 */
async function removeTree(doris: Doris, db: string, rootId: string, ids: readonly string[]): Promise<void> {
  const stored = await doris.query(`SELECT session_id FROM ${db}.agent_sessions WHERE root_id = ${escape(rootId)}`);
  const all = [...new Set([rootId, ...ids, ...stored.map((r) => String(r.session_id))])].map((x) => escape(x)).join(', ');
  for (const t of ['agent_events', 'agent_messages', 'agent_contexts', 'agent_sessions']) {
    await doris.query(`DELETE FROM ${db}.${t} WHERE session_id IN (${all})`);
  }
}

export async function importFile(file: string, deps: { doris: Doris; db: string; load: Load; force?: boolean }): Promise<ImportReport> {
  const id = basename(file, '.jsonl');
  const cursor = await cursorOf(file);
  if (!deps.force) {
    const [row] = await deps.doris.query(`SELECT source_cursor FROM ${deps.db}.agent_sessions WHERE session_id = ${escape(id)}`);
    if (row && row.source_cursor === cursor) {
      return { session: id, status: 'unchanged', branches: 0, events: 0, messages: 0, skipped: {}, malformed: 0, unresolved: 0 };
    }
  }
  const tree = await readTree(file);
  await removeTree(deps.doris, deps.db, id, tree.branches.map((b) => b.record.id));
  const run = randomUUID();
  for (const n of tree.normalised) await writeBranch(deps.load, n, run);
  const totals = totalsFromRows(await deps.doris.query(totalsSql(deps.db, tree.branches.map((b) => b.record.id))));
  const rows = sessionRows(tree.branches, totals, cursor);
  for (const [i, part] of batches(rows).entries()) await deps.load('agent_sessions', labelFor('agent_sessions', id, i, part, run), part);
  return {
    session: id, status: 'imported', branches: tree.branches.length,
    events: tree.normalised.reduce((a, n) => a + n.events.length, 0), messages: tree.normalised.reduce((a, n) => a + n.messages.length, 0),
    skipped: tree.skipped, malformed: tree.malformed, unresolved: tree.unresolved,
  };
}

function line(r: ImportReport): string {
  if (r.status === 'unchanged') return `${r.session}: unchanged`;
  const skipped = Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(', ');
  return `${r.session}: ${r.branches} branch(es), ${r.events} events, ${r.messages} messages`
    + `${skipped ? `; skipped rows: ${skipped}` : ''}${r.malformed ? `; malformed lines: ${r.malformed}` : ''}`
    + `${r.unresolved ? `; unresolved context messages: ${r.unresolved}` : ''}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const paths = args.filter((a) => a !== '--force');
  if (paths.length === 0) {
    console.error('usage: node src/cli/import-transcripts.ts [--force] <dir-or-file>...');
    process.exit(2);
  }
  const doris = new Doris(configFromEnv());
  const db = process.env.DORIS_DB ?? 'otel';
  const cfg = streamLoadConfigFromEnv();
  const load: Load = (table, label, rows) => streamLoad(cfg, db, table, label, rows);
  let failed = 0;
  for (const file of await findTranscripts(paths)) {
    try {
      console.log(line(await importFile(file, { doris, db, load, force })));
    } catch (e) {
      failed += 1;
      console.error(`${file}: ${(e as Error).message}`);
    }
  }
  await doris.close();
  process.exitCode = failed ? 1 : 0;
}
