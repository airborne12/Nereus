// Captures the memories of agents into agent_memories: Claude Code auto memories from a projects
// folder, and Gemini CLI memories from GEMINI.md files. A version is written only when a memory
// changed; leases are kept in the metadata database (META_DATABASE_URL). Import the transcripts
// first: a memory's source is inferred from the sessions already imported.
//
//   node src/cli/capture-memories.ts [--claude <projects folder>]... [--gemini <GEMINI.md>[=<scope>]]... [--owner <name>] [--reinfer]
//
// Without a folder or file it reads ~/.claude/projects and ~/.gemini/GEMINI.md. A scope starts with
// the owner (user@host unless --owner is given), so the memories of two hosts stay apart. --reinfer
// infers again the sources not recorded, after older transcripts were imported. A folder named
// that is missing or cannot be read, or a store that fails, is named and the command exits with 1.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Doris, configFromEnv } from '../db/doris.ts';
import { metaPoolFromEnv, migrate } from '../db/meta.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { Leases } from '../jobs/leases.ts';
import { type CaptureReport, captureStores, type MemoryStore } from '../jobs/memories.ts';
import { readClaudeMemory } from '../semantics/memories/claude-memory.ts';
import { readGeminiMemories } from '../semantics/memories/gemini-memory.ts';
import type { MemoryRecord } from '../semantics/memories/model.ts';

/** The host the command runs on: the home folder, the working folder, and the default owner. */
export interface Host { home: string; cwd: string; owner: string }
/** `named`: a folder or a file was given, so a missing one fails. */
export interface Options { claude: string[]; gemini: { file: string; scope: string }[]; owner: string; reinfer: boolean; named: boolean }

/** The options of the command, paths resolved; without a folder or file, those of the user's home. */
export function parseArgs(args: readonly string[], host: Host): Options {
  let o: Options = { claude: [], gemini: [], owner: host.owner, reinfer: false, named: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    if (flag === '--reinfer') {
      o = { ...o, reinfer: true };
      continue;
    }
    if (flag !== '--claude' && flag !== '--gemini' && flag !== '--owner') throw new Error(`unknown option ${flag}`);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a ${flag === '--claude' ? 'folder' : flag === '--gemini' ? 'file' : 'name'}`);
    i += 1;
    if (flag === '--owner') o = { ...o, owner: value };
    else if (flag === '--claude') o = { ...o, claude: [...o.claude, resolve(host.cwd, value)], named: true };
    else {
      const at = value.indexOf('=');
      const g = at < 0 ? { file: value, scope: 'global' } : { file: value.slice(0, at), scope: value.slice(at + 1) };
      o = { ...o, gemini: [...o.gemini, { ...g, file: resolve(host.cwd, g.file) }], named: true };
    }
  }
  if (o.named) return o;
  return { ...o, claude: [join(host.home, '.claude', 'projects')], gemini: [{ file: join(host.home, '.gemini', 'GEMINI.md'), scope: 'global' }] };
}

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** The names in a folder, sorted; a folder that cannot be read fails, so that its memories are not taken for removed. */
async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (e) {
    throw new Error(`cannot read ${dir}: ${(e as Error).message}`);
  }
}

/**
 * A store per project that has a memory folder, an empty folder included, so that removals are
 * seen; its scope is the owner and the project's folder name. A projects folder that is missing
 * has no store unless it was named.
 */
export async function readClaudeStores(projects: string, owner: string, required: boolean): Promise<MemoryStore[]> {
  const found = await stat(projects).catch((e: unknown) => (missing(e) ? null : Promise.reject(e)));
  if (!found) {
    if (required) throw new Error(`no such folder: ${projects}`);
    return [];
  }
  let stores: MemoryStore[] = [];
  for (const project of await names(projects)) {
    const dir = join(projects, project, 'memory');
    const s = await stat(dir).catch((e: unknown) => (missing(e) ? null : Promise.reject(e)));
    if (!s?.isDirectory()) continue;
    const scope = `${owner}:${project}`;
    let memories: MemoryRecord[] = [];
    for (const n of (await names(dir)).filter((x) => x.endsWith('.md'))) {
      const path = join(dir, n);
      // A file removed while the folder is read is left out, as it would be on the next pass.
      const read = await Promise.all([readFile(path, 'utf8'), stat(path)]).catch((e: unknown) => (missing(e) ? null : Promise.reject(e)));
      const m = read ? readClaudeMemory(scope, path, read[0], read[1].mtimeMs) : null;
      if (m) memories = [...memories, m];
    }
    stores = [...stores, { agent: 'claude-code', scope, memories }];
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
    + `${r.reinferred ? `; ${r.reinferred} inferred again` : ''}${r.held ? `; ${r.held} store(s) left to another runner` : ''}`;
  return [head, ...r.failed.map((f) => `store ${f.store} failed: ${f.error}`)];
}

if (import.meta.main) {
  const db = process.env.DORIS_DB ?? 'otel';
  let close = async () => {};
  try {
    const options = parseArgs(process.argv.slice(2), { home: homedir(), cwd: process.cwd(), owner: `${userInfo().username}@${hostname()}` });
    let stores: MemoryStore[] = [];
    for (const dir of options.claude) stores = [...stores, ...(await readClaudeStores(dir, options.owner, options.named))];
    for (const g of options.gemini) {
      const store = await readGeminiStore(g.file, `${options.owner}:${g.scope}`);
      if (!store && options.named) throw new Error(`no such file: ${g.file}`);
      if (store) stores = [...stores, store];
    }
    const doris = new Doris(configFromEnv());
    const pool = metaPoolFromEnv();
    close = async () => {
      await doris.close();
      await pool.end();
    };
    await migrate(pool);
    const cfg = streamLoadConfigFromEnv();
    const report = await captureStores({ doris, db, load: (t, l, r) => streamLoad(cfg, db, t, l, r), leases: new Leases(pool) }, stores, { reinfer: options.reinfer });
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
