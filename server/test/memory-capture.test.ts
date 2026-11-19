// The memory capture job with stubs in place of Doris, the leases and the loader: a new or changed
// memory gets a row, an unchanged one none, a memory gone from its store a row that says so, and a
// memory with no recorded source the session inferred for it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doris } from '../src/db/doris.ts';
import { captureStores, MEMORY_JOB } from '../src/jobs/memories.ts';
import type { MemoryRecord } from '../src/semantics/memories/model.ts';

const m = (name: string, hash: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
  agent: 'claude-code', scope: 'p', name, format: 'claude-auto-memory', location: `/p/memory/${name}.md`, description: 'Builds reuse their cache with the keep flag', kind: 'project',
  content: 'Run make with the keep flag; a clean build takes forty minutes.', sections: [{ heading: null, text: 'Run make with the keep flag; a clean build takes forty minutes.' }],
  fields: {}, content_hash: hash, updated_at: '2026-11-11 00:00:00.000000', source_session_id: null, source_kind: 'none', ...extra,
});

/** A Doris whose store holds `same` (unchanged), `edited` (another hash) and `gone` (no longer in the folder). */
function doris(found = 9) {
  const seen: string[] = [];
  const d = {
    query: async (sql: string) => {
      seen.push(sql);
      if (sql.startsWith('SELECT name, max_by(content_hash')) {
        const row = (name: string, hash: string) => ({ name, content_hash: hash, location: `/p/memory/${name}.md`, format: 'claude-auto-memory', captured_at: '2026-11-18 10:00:00.000000', source_kind: 'none' });
        return [row('same', 'h-same'), row('edited', 'h-old'), row('gone', 'h-gone'), row('long-gone', 'removed')];
      }
      if (sql.startsWith('WITH texts AS')) return [{ session_id: 'sess-9', found }];
      throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    },
  } as unknown as Doris;
  return { d, seen };
}

function loader() {
  const loads: { table: string; rows: Record<string, unknown>[] }[] = [];
  return { load: async (table: string, _l: string, rows: readonly object[]) => { loads.push({ table, rows: rows as Record<string, unknown>[] }); return 'loaded' as const; }, loads };
}

/** Leases where the units in `held` are another runner's, and a unit in `takes` can be taken that many times, then is another's. */
function leases(held: string[] = [], takes: Record<string, number> = {}) {
  const log: string[] = [];
  const take = async (job: string, unit: string) => {
    log.push(`take ${job} ${unit}`);
    return !held.includes(unit) && log.filter((l) => l === `take ${job} ${unit}`).length <= (takes[unit] ?? Infinity);
  };
  return { store: { take, release: async (_j: string, unit: string) => { log.push(`release ${unit}`); } }, log };
}

const NOW = () => new Date('2026-11-19T10:00:00Z');
const store = { agent: 'claude-code', scope: 'p', memories: [m('same', 'h-same'), m('edited', 'h-new'), m('new', 'h-n', { source_session_id: 'sess-1', source_kind: 'recorded' })] };

test('a capture writes the new and changed versions, and a row for a memory gone from its store', async () => {
  const { load, loads } = loader();
  const { store: l, log } = leases();
  const report = await captureStores({ doris: doris().d, db: 'otel', load, leases: l, now: NOW }, [store]);
  assert.deepEqual(report, { stores: 1, written: 2, removed: 1, unchanged: 1, inferred: 1, reinferred: 0, held: 0, failed: [] });
  const rows = loads.flatMap((x) => x.rows);
  assert.ok(loads.every((x) => x.table === 'agent_memories'));
  assert.deepEqual(rows.map((r) => [r.name, r.content_hash, r.captured_at, r.source_kind, r.source_session_id]), [
    ['edited', 'h-new', '2026-11-19 10:00:00.000000', 'inferred', 'sess-9'],
    ['new', 'h-n', '2026-11-19 10:00:00.000000', 'recorded', 'sess-1'],
    ['gone', 'removed', '2026-11-19 10:00:00.000000', null, null],
  ]);
  assert.deepEqual(log, [`take ${MEMORY_JOB} claude-code/p`, `take ${MEMORY_JOB} claude-code/p`, 'release claude-code/p'], 'the lease is renewed before the inference');
});

test('a memory whose best session holds half of its words or fewer has no source', async () => {
  const { load, loads } = loader();
  const words = 11; // the words of `m`: builds reuse their cache keep flag make clean build takes forty minutes, less common ones
  await captureStores({ doris: doris(2).d, db: 'otel', load, leases: leases().store, now: NOW }, [store]);
  const edited = loads.flatMap((x) => x.rows).find((r) => r.name === 'edited')!;
  assert.deepEqual([edited.source_kind, edited.source_session_id, edited.source_score], ['none', null, null], `found 2 of about ${words}`);
});

test('a memory with too few words is not matched; a store another runner holds is left to it', async () => {
  const short = { agent: 'claude-code', scope: 'p', memories: [m('edited', 'h-new', { description: null, sections: [], content: 'Use pnpm.' })] };
  const { d, seen } = doris();
  const report = await captureStores({ doris: d, db: 'otel', load: loader().load, leases: leases().store, now: NOW }, [short]);
  assert.equal(report.inferred, 0);
  assert.ok(!seen.some((s) => s.startsWith('WITH texts AS')));
  const held = await captureStores({ doris: doris().d, db: 'otel', load: loader().load, leases: leases(['claude-code/p']).store, now: NOW }, [store]);
  assert.deepEqual(held, { stores: 0, written: 0, removed: 0, unchanged: 0, inferred: 0, reinferred: 0, held: 1, failed: [] });
});

test('two memories of one name in a store are one; a store that fails is named and the others go on', async () => {
  const twice = { agent: 'gemini-cli', scope: 'global', memories: [m('same', 'h-1', { agent: 'gemini-cli', scope: 'global' }), m('same', 'h-2', { agent: 'gemini-cli', scope: 'global' })] };
  const broken = { query: async () => { throw new Error('Doris is down'); } } as unknown as Doris;
  const report = await captureStores({ doris: broken, db: 'otel', load: loader().load, leases: leases().store, now: NOW }, [twice]);
  assert.deepEqual(report.failed, [{ store: 'gemini-cli/global', error: 'Doris is down' }]);
  const { load, loads } = loader();
  const empty = { query: async (sql: string) => (sql.startsWith('SELECT name') ? [] : [{ session_id: 's', found: 0 }]) } as unknown as Doris;
  await captureStores({ doris: empty, db: 'otel', load, leases: leases().store, now: NOW }, [twice]);
  assert.deepEqual(loads.flatMap((x) => x.rows).map((r) => [r.name, r.content_hash]), [['same', 'h-1']]);
});

test('a store taken over while its sources are inferred writes nothing and is left to the other runner', async () => {
  const { load, loads } = loader();
  const report = await captureStores({ doris: doris().d, db: 'otel', load, leases: leases([], { 'claude-code/p': 1 }).store, now: NOW }, [store]);
  assert.deepEqual([report.stores, report.held, loads.length], [0, 1, 0]);
});

test('a store whose scope is longer than its column is set aside and named; the others go on', async () => {
  const wide = { agent: 'claude-code', scope: 'p'.repeat(300), memories: [m('x', 'h')] };
  const { d, seen } = doris();
  const report = await captureStores({ doris: d, db: 'otel', load: loader().load, leases: leases().store, now: NOW }, [wide, store]);
  assert.deepEqual(report.failed, [{ store: `claude-code/${'p'.repeat(300)}`, error: 'the scope is longer than 256 bytes' }]);
  assert.equal(report.stores, 1);
  assert.ok(seen.every((s) => !s.includes('p'.repeat(300))), 'nothing of it is read or written');
});

test('--reinfer infers again the source of a latest version not recorded, and rewrites the same row', async () => {
  const { load, loads } = loader();
  const report = await captureStores({ doris: doris().d, db: 'otel', load, leases: leases().store, now: NOW }, [{ ...store, memories: [m('same', 'h-same')] }], { reinfer: true });
  assert.equal(report.reinferred, 1);
  assert.deepEqual(loads.flatMap((x) => x.rows).filter((r) => r.name === 'same').map((r) => [r.captured_at, r.source_kind, r.source_session_id]), [['2026-11-18 10:00:00.000000', 'inferred', 'sess-9']]);
  const { load: plain, loads: none } = loader();
  await captureStores({ doris: doris().d, db: 'otel', load: plain, leases: leases().store, now: NOW }, [{ ...store, memories: [m('same', 'h-same')] }]);
  assert.equal(none.flatMap((x) => x.rows).filter((r) => r.name === 'same').length, 0, 'without --reinfer an unchanged memory writes nothing');
});
