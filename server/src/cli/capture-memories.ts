// Captures the memories of agents into agent_memories: Claude Code auto memories from a projects
// folder, and Gemini CLI memories from GEMINI.md files. A version is written only when a memory
// changed; leases are kept in the metadata database (META_DATABASE_URL).
//
//   node src/cli/capture-memories.ts [--claude <projects folder>]... [--gemini <GEMINI.md>[=<scope>]]...
//
// Without options it reads ~/.claude/projects and ~/.gemini/GEMINI.md. A store that fails is named
// and the command exits with 1.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Doris, configFromEnv } from '../db/doris.ts';
import { metaPoolFromEnv, migrate } from '../db/meta.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { Leases } from '../jobs/leases.ts';
import { type CaptureReport, captureStores, type MemoryStore } from '../jobs/memories.ts';
import { readClaudeMemory } from '../semantics/memories/claude-memory.ts';
import { readGeminiMemories } from '../semantics/memories/gemini-memory.ts';
import type { MemoryRecord } from '../semantics/memories/model.ts';

export interface Options { claude: string[]; gemini: { file: string; scope: string }[] }

/** The options of the command; without any, the folders of the user's home. */
export function parseArgs(args: readonly string[], home: string): Options {
  let claude: string[] = [];
  let gemini: Options['gemini'] = [];
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i]!, args[i + 1]];
    if (flag !== '--claude' && flag !== '--gemini') throw new Error(`unknown option ${flag}`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a ${flag === '--claude' ? 'folder' : 'file'}`);
    if (flag === '--claude') claude = [...claude, value];
    else {
      const at = value.indexOf('=');
      gemini = [...gemini, at < 0 ? { file: value, scope: 'global' } : { file: value.slice(0, at), scope: value.slice(at + 1) }];
    }
  }
  if (!args.length) return { claude: [join(home, '.claude', 'projects')], gemini: [{ file: join(home, '.gemini', 'GEMINI.md'), scope: 'global' }] };
  return { claude, gemini };
}

const names = (dir: string): Promise<string[]> => readdir(dir).then((n) => n.sort(), () => []);

/** A store per project that has a memory folder, an empty folder included, so that removals are seen. */
export async function readClaudeStores(projects: string): Promise<MemoryStore[]> {
  let stores: MemoryStore[] = [];
  for (const project of await names(projects)) {
    const dir = join(projects, project, 'memory');
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) continue;
    let memories: MemoryRecord[] = [];
    for (const n of (await names(dir)).filter((x) => x.endsWith('.md'))) {
      const path = join(dir, n);
      const m = readClaudeMemory(path, await readFile(path, 'utf8'), (await stat(path)).mtimeMs);
      if (m) memories = [...memories, m];
    }
    stores = [...stores, { agent: 'claude-code', scope: project, memories }];
  }
  return stores;
}

/** The store of one GEMINI.md; none when the file does not exist. */
export async function readGeminiStore(file: string, scope: string): Promise<MemoryStore | null> {
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return null;
  return { agent: 'gemini-cli', scope, memories: readGeminiMemories(file, await readFile(file, 'utf8'), scope, s.mtimeMs) };
}

/** What the command prints: one line for the pass, then one per store that failed. */
export function summary(r: CaptureReport): string[] {
  const head = `${r.stores} store(s): ${r.written} version(s) written, ${r.removed} removed, ${r.unchanged} unchanged; ${r.inferred} source(s) inferred`
    + `${r.held ? `; ${r.held} store(s) left to another runner` : ''}`;
  return [head, ...r.failed.map((f) => `store ${f.store} failed: ${f.error}`)];
}

if (import.meta.main) {
  const db = process.env.DORIS_DB ?? 'otel';
  let close = async () => {};
  try {
    const options = parseArgs(process.argv.slice(2), homedir());
    const doris = new Doris(configFromEnv());
    const pool = metaPoolFromEnv();
    close = async () => {
      await doris.close();
      await pool.end();
    };
    await migrate(pool);
    let stores: MemoryStore[] = [];
    for (const dir of options.claude) stores = [...stores, ...(await readClaudeStores(dir))];
    for (const g of options.gemini) {
      const store = await readGeminiStore(g.file, g.scope);
      if (store) stores = [...stores, store];
    }
    const cfg = streamLoadConfigFromEnv();
    const report = await captureStores({ doris, db, load: (t, l, r) => streamLoad(cfg, db, t, l, r), leases: new Leases(pool) }, stores);
    const [head, ...problems] = summary(report);
    console.log(head);
    for (const p of problems) console.error(p);
    if (report.failed.length) process.exitCode = 1;
  } catch (e) {
    console.error(`capture-memories failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
