// The memory capture job (spec 6.5): for each store — one agent's memories of one scope, as an
// adapter read them — it writes a version of each memory whose content hash changed, a row for each
// memory gone from the store, and infers the source of a new version whose agent did not record it.
// Asked to, it infers again the source of a latest version not recorded and rewrites that row. A
// store is a unit of work with its own lease, renewed before each inference.

import type { Doris } from '../db/doris.ts';
import { batches, labelFor, type Load } from '../semantics/ingest/writer.ts';
import { type MemoryRecord, SCOPE_BYTES } from '../semantics/memories/model.ts';
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
/** `reinfer`: infer again the source of each latest version whose agent did not record it. */
export interface CaptureOptions { reinfer?: boolean }
/** A store whose capture failed, and why. */
export interface CaptureFailed { store: string; error: string }
export interface CaptureReport { stores: number; written: number; removed: number; unchanged: number; inferred: number; reinferred: number; held: number; failed: CaptureFailed[] }
type Counts = Pick<CaptureReport, 'written' | 'removed' | 'unchanged' | 'inferred' | 'reinferred'>;

class LostLease extends Error {}

const unitOf = (s: { agent: string; scope: string }): string => `${s.agent}/${s.scope}`;

/** The source of a version: the recorded one, or the session its words infer, after the store's lease is renewed. */
async function sourceFor(deps: CaptureDeps, m: MemoryRecord, renew: () => Promise<boolean>): Promise<Source> {
  if (m.source_kind === 'recorded') return { source_session_id: m.source_session_id, source_kind: 'recorded', source_score: null };
  const words = memoryWords(m);
  if (words.length < MIN_WORDS) return NO_SOURCE;
  if (!(await renew())) throw new LostLease();
  return sourceOf(await deps.doris.query(inferSourceSql(deps.db, m, words).sql), words);
}

async function captureStore(deps: CaptureDeps, store: MemoryStore, at: string, run: string, opts: CaptureOptions): Promise<Counts> {
  const renew = () => deps.leases.take(MEMORY_JOB, unitOf(store), LEASE_SECONDS);
  const stored = new Map((await deps.doris.query(storeVersionsSql(deps.db, store.agent, store.scope).sql)).map((r) => [String(r.name), r]));
  // Two memories of one name in a store are one: the first is kept.
  const unique = store.memories.filter((m, i) => store.memories.findIndex((x) => x.name === m.name) === i);
  const changed = unique.filter((m) => String(stored.get(m.name)?.content_hash ?? '') !== m.content_hash);
  const names = new Set(unique.map((m) => m.name));
  const gone = [...stored.values()].filter((r) => !names.has(String(r.name)) && r.content_hash !== REMOVED);
  let sources: Source[] = [];
  for (const m of changed) sources = [...sources, await sourceFor(deps, m, renew)];
  // An unchanged version whose source is not recorded is inferred again when asked, and its row rewritten.
  const again = opts.reinfer ? unique.filter((m) => !changed.includes(m) && m.source_kind !== 'recorded' && ['none', 'inferred'].includes(String(stored.get(m.name)?.source_kind))) : [];
  let rewritten: Record<string, unknown>[] = [];
  for (const m of again) {
    const s = await sourceFor(deps, m, renew);
    if (s.source_kind === 'inferred' || stored.get(m.name)?.source_kind === 'inferred') rewritten = [...rewritten, memoryRow(m, String(stored.get(m.name)!.captured_at), s)];
  }
  const rows = [
    ...changed.map((m, i) => memoryRow(m, at, sources[i]!)),
    ...rewritten,
    ...gone.map((r) => removedRow({ agent: store.agent, scope: store.scope, name: String(r.name), location: r.location === null ? null : String(r.location), format: r.format === null ? null : String(r.format) }, at)),
  ];
  for (const [i, part] of batches(rows).entries()) await deps.load('agent_memories', labelFor('agent_memories', unitOf(store), i, part, run), part);
  return {
    written: changed.length, removed: gone.length, unchanged: unique.length - changed.length,
    inferred: sources.filter((s) => s.source_kind === 'inferred').length, reinferred: rewritten.length,
  };
}

/**
 * One pass over the stores read. A store another runner holds, or takes over while its sources are
 * inferred, is left to it; a store that fails, or whose scope does not fit its column, is named and
 * the others go on.
 */
export async function captureStores(deps: CaptureDeps, stores: readonly MemoryStore[], opts: CaptureOptions = {}): Promise<CaptureReport> {
  const at = dorisTime((deps.now ?? (() => new Date()))().toISOString());
  const run = at.replace(/\D/g, '');
  let report: CaptureReport = { stores: 0, written: 0, removed: 0, unchanged: 0, inferred: 0, reinferred: 0, held: 0, failed: [] };
  for (const store of stores) {
    const unit = unitOf(store);
    if (Buffer.byteLength(store.scope) > SCOPE_BYTES) {
      report = { ...report, failed: [...report.failed, { store: unit, error: `the scope is longer than ${SCOPE_BYTES} bytes` }] };
      continue;
    }
    if (!(await deps.leases.take(MEMORY_JOB, unit, LEASE_SECONDS))) {
      report = { ...report, held: report.held + 1 };
      continue;
    }
    try {
      const c = await captureStore(deps, store, at, run, opts);
      report = {
        ...report, stores: report.stores + 1, written: report.written + c.written, removed: report.removed + c.removed,
        unchanged: report.unchanged + c.unchanged, inferred: report.inferred + c.inferred, reinferred: report.reinferred + c.reinferred,
      };
    } catch (e) {
      if (e instanceof LostLease) report = { ...report, held: report.held + 1 };
      else report = { ...report, failed: [...report.failed, { store: unit, error: (e as Error).message }] };
    } finally {
      await deps.leases.release(MEMORY_JOB, unit);
    }
  }
  return report;
}
