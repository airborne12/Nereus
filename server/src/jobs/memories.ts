// The memory capture job (spec 6.5): for each store — one agent's memories of one scope, as an
// adapter read them — it writes a version of each memory whose content hash changed, a row for each
// memory gone from the store, and infers the source of a new version whose agent did not record it.
// A store is a unit of work with its own lease.

import type { Doris } from '../db/doris.ts';
import { batches, labelFor, type Load } from '../semantics/ingest/writer.ts';
import type { MemoryRecord } from '../semantics/memories/model.ts';
import { inferSourceSql, memoryWords, MIN_WORDS, NO_SOURCE, type Source, sourceOf } from '../semantics/memories/source.ts';
import { memoryRow, REMOVED, removedRow, storeVersionsSql } from '../semantics/memories/statements.ts';
import { dorisTime } from '../semantics/trajectory/model.ts';
import type { LeaseStore } from './leases.ts';

export const MEMORY_JOB = 'memory-capture';
/** How long a runner may take over one store before another may take it. */
const LEASE_SECONDS = 300;

/** The memories an adapter read from one store. */
export interface MemoryStore { agent: string; scope: string; memories: MemoryRecord[] }
export interface CaptureDeps { doris: Doris; db: string; load: Load; leases: LeaseStore; now?: () => Date }
/** A store whose capture failed, and why. */
export interface CaptureFailed { store: string; error: string }
export interface CaptureReport { stores: number; written: number; removed: number; unchanged: number; inferred: number; held: number; failed: CaptureFailed[] }
type Counts = Pick<CaptureReport, 'written' | 'removed' | 'unchanged' | 'inferred'>;

const unitOf = (s: { agent: string; scope: string }): string => `${s.agent}/${s.scope}`;

/** The source of a new version: the recorded one, or the session its words infer. */
async function sourceFor(deps: CaptureDeps, m: MemoryRecord): Promise<Source> {
  if (m.source_kind === 'recorded') return { source_session_id: m.source_session_id, source_kind: 'recorded', source_score: null };
  const words = memoryWords(m);
  if (words.length < MIN_WORDS) return NO_SOURCE;
  return sourceOf(await deps.doris.query(inferSourceSql(deps.db, m, words).sql), words);
}

async function captureStore(deps: CaptureDeps, store: MemoryStore, at: string, run: string): Promise<Counts> {
  const stored = new Map((await deps.doris.query(storeVersionsSql(deps.db, store.agent, store.scope).sql)).map((r) => [String(r.name), r]));
  // Two memories of one name in a store are one: the first is kept.
  const unique = store.memories.filter((m, i) => store.memories.findIndex((x) => x.name === m.name) === i);
  const changed = unique.filter((m) => String(stored.get(m.name)?.content_hash ?? '') !== m.content_hash);
  const names = new Set(unique.map((m) => m.name));
  const gone = [...stored.values()].filter((r) => !names.has(String(r.name)) && r.content_hash !== REMOVED);
  let sources: Source[] = [];
  for (const m of changed) sources = [...sources, await sourceFor(deps, m)];
  const rows = [
    ...changed.map((m, i) => memoryRow(m, at, sources[i]!)),
    ...gone.map((r) => removedRow({ agent: store.agent, scope: store.scope, name: String(r.name), location: r.location === null ? null : String(r.location), format: r.format === null ? null : String(r.format) }, at)),
  ];
  for (const [i, part] of batches(rows).entries()) await deps.load('agent_memories', labelFor('agent_memories', unitOf(store), i, part, run), part);
  return { written: changed.length, removed: gone.length, unchanged: unique.length - changed.length, inferred: sources.filter((s) => s.source_kind === 'inferred').length };
}

/** One pass over the stores read. A store another runner holds is left to it; a store that fails is named and the others go on. */
export async function captureStores(deps: CaptureDeps, stores: readonly MemoryStore[]): Promise<CaptureReport> {
  const at = dorisTime((deps.now ?? (() => new Date()))().toISOString());
  const run = at.replace(/\D/g, '');
  let report: CaptureReport = { stores: 0, written: 0, removed: 0, unchanged: 0, inferred: 0, held: 0, failed: [] };
  for (const store of stores) {
    const unit = unitOf(store);
    if (!(await deps.leases.take(MEMORY_JOB, unit, LEASE_SECONDS))) {
      report = { ...report, held: report.held + 1 };
      continue;
    }
    try {
      const c = await captureStore(deps, store, at, run);
      report = { ...report, stores: report.stores + 1, written: report.written + c.written, removed: report.removed + c.removed, unchanged: report.unchanged + c.unchanged, inferred: report.inferred + c.inferred };
    } catch (e) {
      report = { ...report, failed: [...report.failed, { store: unit, error: (e as Error).message }] };
    } finally {
      await deps.leases.release(MEMORY_JOB, unit);
    }
  }
  return report;
}
