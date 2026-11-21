// The validity fold job with stubs in place of Doris, the leases and the model: each memory's reads
// are judged one after another, oldest first, each from the state the one before left; a call that
// gives no update leaves the rest of that memory for the next pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doris } from '../src/db/doris.ts';
import { judgeMemories, VALIDITY_JOB } from '../src/jobs/validity.ts';
import type { FoldModel } from '../src/semantics/judges/fold-model.ts';
import { ModelAccessError } from '../src/semantics/judges/model.ts';
import { FOLD_SYSTEM } from '../src/semantics/memories/validity.ts';

const A = { agent: 'claude-code', scope: 'p', name: 'build', content_hash: 'a'.repeat(64), description: 'Use --keep', content: 'Run make with --keep.', subject: 'sub-a' };
const B = { ...A, name: 'deploy', content: 'Deploys wait for the mirror.', subject: 'sub-b' };

/** A Doris with two reads of memory A (judged once before, in doubt) and one of memory B (never judged). */
function doris() {
  const seen: string[] = [];
  const d = {
    query: async (sql: string) => {
      seen.push(sql);
      if (sql.startsWith('WITH kept AS')) {
        return [{ ...A, session_id: 's-1', seq: 10 }, { ...A, session_id: 's-2', seq: 20 }, { ...B, session_id: 's-3', seq: 30 }];
      }
      if (sql.startsWith('SELECT version, state, reason')) return sql.includes("'sub-a'") ? [{ version: 2, state: 'doubt', reason: 'Another flag was used.' }] : [];
      if (sql.startsWith('WITH r AS')) {
        return [...sql.matchAll(/e\.session_id = '([^']+)' AND e\.seq = (\d+)/g)].map((m) => ({
          read_session: m[1], read_seq: Number(m[2]), seq: Number(m[2]), event_kind: 'llm_call', step: 4, name: null, status: 'ok', target: '', args: null,
          msg_seq: 1, kind: 'text', is_error: null, text: `read in ${m[1]}`,
        }));
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    },
  } as unknown as Doris;
  return { d, seen };
}

function loader() {
  const loads: { table: string; rows: Record<string, unknown>[] }[] = [];
  return { load: async (table: string, _l: string, rows: readonly object[]) => { loads.push({ table, rows: rows as Record<string, unknown>[] }); return 'loaded' as const; }, loads };
}
function leases(held: string[] = []) {
  const log: string[] = [];
  return { store: { take: async (job: string, unit: string) => { log.push(`take ${job} ${unit}`); return !held.includes(unit); }, release: async (_j: string, unit: string) => { log.push(`release ${unit}`); } }, log };
}
const NOW = () => new Date('2026-11-19T10:00:00Z');
const judged = (loads: ReturnType<typeof loader>['loads']) => loads.filter((l) => l.table === 'agent_judgments').flatMap((l) => l.rows);

/** A model that says the session in s-2 shows the memory is out of date, and the others support it. */
const model = (): { m: FoldModel; seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    m: {
      fold: async (_model, system, text) => {
        seen.push(text);
        assert.equal(system, FOLD_SYSTEM);
        return text.includes('read in s-2') ? { evidence: 'conflicts', state: 'outdated', reason: 'Renamed.', inputTokens: 500, outputTokens: 20 }
          : { evidence: 'supports', state: 'holds', reason: 'Used as written.', inputTokens: 500, outputTokens: 20 };
      },
    },
  };
};

test("each memory's reads are judged in order, each from the state the one before left, and the judge is published", async () => {
  const { load, loads } = loader();
  const { m, seen } = model();
  const { store, log } = leases();
  const report = await judgeMemories({ doris: doris().d, db: 'otel', load, model: m, leases: store, now: NOW });
  assert.deepEqual(report, { judged: 3, stopped: false, held: 0, failed: [], missed: null, unanswered: null });
  assert.deepEqual(judged(loads).map((r) => [r.subject, r.version, r.prev_version, r.session_id, r.seq, r.evidence, r.state]), [
    ['sub-a', 3, 2, 's-1', 10, 'supports', 'holds'], ['sub-a', 4, 3, 's-2', 20, 'conflicts', 'outdated'], ['sub-b', 1, null, 's-3', 30, 'supports', 'holds'],
  ]);
  assert.match(seen[0]!, /<state>doubt: Another flag was used\.<\/state>/, 'the first read of A starts from its stored state');
  assert.match(seen[1]!, /<state>holds: Used as written\.<\/state>/, 'the second from the state the first left');
  assert.match(seen[2]!, /<state>No session has been judged against it yet/);
  const row = judged(loads)[0]!;
  assert.deepEqual([row.judge, row.judge_version, row.verdict, row.model, row.input_tokens, row.judged_at], ['memory-validity', 1, null, 'claude-haiku-5-5', 500, '2026-11-19 10:00:00.000000']);
  assert.deepEqual(loads.filter((l) => l.table === 'agent_judges').map((l) => [l.rows[0]!.judge, l.rows[0]!.form]), [['memory-validity', 'fold']]);
  assert.deepEqual(log.filter((l) => l.startsWith('take')), [`take ${VALIDITY_JOB} sub-a`, `take ${VALIDITY_JOB} sub-a`, `take ${VALIDITY_JOB} sub-a`, `take ${VALIDITY_JOB} sub-b`, `take ${VALIDITY_JOB} sub-b`]);
});

test('a call that gives no update stores nothing and leaves the rest of that memory for the next pass', async () => {
  const { load, loads } = loader();
  const missing: FoldModel = { fold: async (_m, _s, text) => (text.includes('read in s-1') ? { missed: 'The model could not be reached: 529', inputTokens: 0, outputTokens: 0 } : { evidence: 'none', state: 'holds', reason: 'x', inputTokens: 500, outputTokens: 20 }) };
  const report = await judgeMemories({ doris: doris().d, db: 'otel', load, model: missing, leases: leases().store, now: NOW });
  assert.deepEqual(report, { judged: 1, stopped: false, held: 0, failed: [], missed: { calls: 1, reason: 'The model could not be reached: 529' }, unanswered: null });
  assert.deepEqual(judged(loads).map((r) => r.subject), ['sub-b']);
});

test('the pass stops before it would go over its budget; a memory another runner holds is left to it; a wrong key ends the pass', async () => {
  const stopped = await judgeMemories({ doris: doris().d, db: 'otel', load: loader().load, model: model().m, leases: leases().store, budget: 300 });
  assert.deepEqual([stopped.judged, stopped.stopped], [0, true]);
  const held = await judgeMemories({ doris: doris().d, db: 'otel', load: loader().load, model: model().m, leases: leases(['sub-a']).store });
  assert.deepEqual([held.judged, held.held], [1, 1]);
  const wrong: FoldModel = { fold: async () => { throw new ModelAccessError('The model cannot be used: invalid x-api-key'); } };
  const failed = await judgeMemories({ doris: doris().d, db: 'otel', load: loader().load, model: wrong, leases: leases().store });
  assert.deepEqual(failed.failed, [{ memory: 'claude-code/p/build', error: 'The model cannot be used: invalid x-api-key' }]);
  assert.equal(failed.judged, 0);
});

test('a read counts once its turn is finished: the due reads are those of sessions quiet for ten minutes or with a later turn', async () => {
  const { d, seen } = doris();
  await judgeMemories({ doris: d, db: 'otel', load: loader().load, model: model().m, leases: leases().store, now: NOW });
  assert.match(seen[0]!, /s\.last_event_at < '2026-11-19 09:50:00\.000000'/);
});

test('a read another runner judged after this one listed it is not judged again', async () => {
  const stored: Record<string, unknown>[] = [];
  const d = {
    query: async (sql: string) => {
      if (sql.startsWith('WITH kept AS')) return [{ ...A, session_id: 's-1', seq: 10 }];
      if (sql.startsWith('SELECT version, state, reason')) return [...stored].reverse();
      if (sql.startsWith('WITH r AS')) return doris().d.query(sql);
      throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    },
  } as unknown as Doris;
  const load = async (table: string, _l: string, rows: readonly object[]) => { if (table === 'agent_judgments') stored.push(...(rows as Record<string, unknown>[])); return 'loaded' as const; };
  const first = await judgeMemories({ doris: d, db: 'otel', load, model: model().m, leases: leases().store, now: NOW });
  const second = await judgeMemories({ doris: d, db: 'otel', load, model: model().m, leases: leases().store, now: NOW });
  assert.deepEqual([first.judged, second.judged, stored.length], [1, 0, 1], 'the list of the second runner was read before the first stored its update');
});

test('an answer that is not an update is stored as no judgment, and the fold goes on from the state before it', async () => {
  const { load, loads } = loader();
  const refusing: FoldModel = {
    fold: async (_m, _s, text) => (text.includes('read in s-1') ? { missed: 'The model declined to judge this session.', inputTokens: 500, outputTokens: 3 }
      : { evidence: 'supports', state: 'holds', reason: 'Used as written.', inputTokens: 500, outputTokens: 20 }),
  };
  const seen: string[] = [];
  const watching: FoldModel = { fold: async (m, s, text) => { seen.push(text); return refusing.fold(m, s, text); } };
  const report = await judgeMemories({ doris: doris().d, db: 'otel', load, model: watching, leases: leases().store, now: NOW });
  assert.deepEqual([report.judged, report.missed, report.unanswered], [2, null, { calls: 1, reason: 'The model declined to judge this session.' }]);
  assert.deepEqual(judged(loads).map((r) => [r.subject, r.version, r.prev_version, r.session_id, r.verdict, r.evidence, r.state, r.reason]), [
    ['sub-a', 3, 2, 's-1', 'unsure', null, null, 'The model declined to judge this session.'],
    ['sub-a', 4, 3, 's-2', null, 'supports', 'holds', 'Used as written.'],
    ['sub-b', 1, null, 's-3', null, 'supports', 'holds', 'Used as written.'],
  ]);
  assert.match(seen[1]!, /<state>doubt: Another flag was used\.<\/state>/, 'the read after it starts from the state before it');
});

test('a budget of 0 turns the pass off', async () => {
  const quiet = { query: async () => { throw new Error('nothing should be read'); } } as unknown as Doris;
  assert.deepEqual(await judgeMemories({ doris: quiet, db: 'otel', load: loader().load, model: model().m, leases: leases().store, budget: 0 }), { judged: 0, stopped: false, held: 0, failed: [], missed: null, unanswered: null });
});

test('with a model given, the fold asks it and each update records it; the judge version stays as it is', async () => {
  const { load, loads } = loader();
  const asked: string[] = [];
  const watching: FoldModel = { fold: async (m, s, t) => { asked.push(m); return model().m.fold(m, s, t); } };
  await judgeMemories({ doris: doris().d, db: 'otel', load, model: watching, leases: leases().store, now: NOW, judgeModel: 'gemini-3.5-flash' });
  assert.deepEqual([...new Set(asked)], ['gemini-3.5-flash']);
  assert.deepEqual([...new Set(loads.filter((l) => l.table === 'agent_judges').flatMap((l) => l.rows.map((r) => r.model)))], ['claude-haiku-5-5'], 'the version keeps the model it has in code');
  assert.deepEqual([...new Set(loads.filter((l) => l.table === 'agent_judgments').flatMap((l) => l.rows.map((r) => r.model)))], ['gemini-3.5-flash']);
});
