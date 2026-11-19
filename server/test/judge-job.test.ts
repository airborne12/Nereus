// The judge job with stubs in place of Doris, the queue and the model: a run judges its steps in
// batches, stays within its budget, stops on a model that cannot be used or never answers, stops
// writing when another runner has taken it, and judges that follow new sessions get a run when
// there is something new.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthError } from '../src/control/auth/store.ts';
import type { JudgeRecord, RunRecord } from '../src/control/judges/store.ts';
import type { Doris } from '../src/db/doris.ts';
import { type JudgeQueue, queueNewSessions, runJudges, runOne } from '../src/jobs/judges.ts';
import type { JudgeVersion } from '../src/semantics/judges/judge.ts';
import { type JudgeModel, ModelAccessError } from '../src/semantics/judges/model.ts';

const V1: JudgeVersion = {
  judge: 'edits-a1', version: 1, name: 'Edits', pick: { tool: 'Edit', has: '', status: 'any' }, reads: { kind: 'step' },
  criterion: 'Is the test fitted?', model: 'claude-haiku-5-5', createdAt: '2026-11-19 08:00:00.000000', createdBy: 'ada@example.com',
};
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 7, judge: 'edits-a1', version: 1, scope: 'picked', status: 'running', budget: 1_000_000, steps: null, judged: 0, inputTokens: 0, outputTokens: 0,
  error: null, createdAt: '', createdBy: 'ada@example.com', startedAt: '', finishedAt: null, ...over,
});

/** A Doris that knows `n` steps of session s-1 to judge, each one model call with one line of text. */
function doris(n: number, log: string[] = []) {
  return {
    query: async (sql: string) => {
      if (sql.startsWith('WITH judged AS')) {
        const asked = [...sql.matchAll(/j\.seq = (\d+)/g)].map((m) => Number(m[1]));
        log.push(`read ${asked.join(',')}`);
        return asked.map((seq) => ({ session_id: 's-1', judged: seq, seq, event_kind: 'llm_call', step: seq, name: null, status: 'ok', target: '', args: null, msg_seq: seq, kind: 'text', is_error: null, text: seq % 2 ? 'fitted' : 'fixed' }));
      }
      if (sql.includes('FROM picked p')) {
        log.push(`subjects${sql.endsWith('LIMIT 1') ? ' (any)' : ''}`);
        return Array.from({ length: n }, (_, i) => ({ session_id: 's-1', seq: i + 1 }));
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 40)}`);
    },
  } as unknown as Doris;
}

/** A queue whose writes succeed until `lostAfter` progress writes, as if another runner then took the run. */
function queue(versions: JudgeVersion[] = [V1], lostAfter = Infinity) {
  const calls: string[] = [];
  let written = 0;
  const q: JudgeQueue = {
    versions: async () => versions,
    started: async (id, runner, steps) => { calls.push(`started ${id} ${runner} ${steps}`); return true; },
    progress: async (id, runner, judged, i, o) => { written += 1; calls.push(`progress ${id} ${judged} ${i} ${o}`); return written <= lostAfter; },
    finish: async (id, runner, status, error) => { calls.push(`finish ${id} ${status}${error ? `: ${error}` : ''}`); return true; },
    judges: async () => [],
    hasOpenRun: async () => false,
    enqueue: async () => run(),
    claim: async () => null,
  };
  return { q, calls };
}

const model: JudgeModel = { judge: async (_m, _c, excerpt) => (excerpt.includes('fitted') ? { verdict: 'violates', reason: 'fitted', inputTokens: 100, outputTokens: 5 } : { verdict: 'ok', reason: 'fixed', inputTokens: 100, outputTokens: 5 }) };

function loader() {
  const loads: { table: string; rows: Record<string, unknown>[] }[] = [];
  const load = async (table: string, _label: string, rows: readonly object[]) => { loads.push({ table, rows: rows as Record<string, unknown>[] }); return 'loaded' as const; };
  return { load, loads };
}

test('a run publishes the judge versions, then judges its steps a chunk at a time and records how far it came', async () => {
  const log: string[] = [];
  const { q, calls } = queue();
  const { load, loads } = loader();
  const report = await runOne({ doris: doris(5, log), db: 'otel', load, store: q, model, runner: 'r1', batch: 4, concurrency: 2 }, run());
  assert.deepEqual(report, { run: 7, judge: 'edits-a1', status: 'done', judged: 5, error: null });
  assert.deepEqual(log, ['subjects', 'read 1,2,3,4', 'read 5']);
  assert.deepEqual(loads.map((l) => [l.table, l.rows.length]), [['agent_judges', 1], ['agent_judgments', 2], ['agent_judgments', 2], ['agent_judgments', 1]]);
  assert.deepEqual(loads[0]!.rows[0], { judge: 'edits-a1', version: 1, name: 'Edits', form: 'map', pick: V1.pick, reads: V1.reads, criterion: V1.criterion, model: V1.model, created_at: V1.createdAt, created_by: V1.createdBy });
  assert.deepEqual(loads.slice(1).flatMap((l) => l.rows.map((r) => `${r.subject} ${r.verdict}`)), ['s-1:1 violates', 's-1:2 ok', 's-1:3 violates', 's-1:4 ok', 's-1:5 violates']);
  assert.deepEqual(calls, ['started 7 r1 5', 'progress 7 2 200 10', 'progress 7 4 400 20', 'progress 7 5 500 25', 'finish 7 done']);
});

test('a run taken over from a quiet runner goes on from its counts', async () => {
  const { q, calls } = queue();
  await runOne({ doris: doris(2), db: 'otel', load: loader().load, store: q, model, runner: 'r2', batch: 5 }, run({ judged: 3, inputTokens: 300, outputTokens: 15 }));
  assert.deepEqual(calls, ['started 7 r2 5', 'progress 7 5 500 25', 'finish 7 done']);
});

test('a run stops before a chunk would go over its budget, counting the tokens the model really took', async () => {
  const { q, calls } = queue();
  const { load, loads } = loader();
  const dear: JudgeModel = { judge: async () => ({ verdict: 'ok', reason: 'fine', inputTokens: 10_000, outputTokens: 5 }) };
  const report = await runOne({ doris: doris(10), db: 'otel', load, store: q, model: dear, runner: 'r1', batch: 20, concurrency: 2 }, run({ budget: 25_000 }));
  assert.deepEqual([report.status, report.judged], ['stopped', 2]);
  assert.equal(loads.filter((l) => l.table === 'agent_judgments').length, 1);
  assert.equal(calls.at(-1), 'finish 7 stopped: Stopped before going over the budget of 25000 input tokens: 2 of 10 steps judged.');
});

test('a model that cannot be used, or that no call reaches, fails the run and stores nothing of that chunk', async () => {
  const { q, calls } = queue();
  const { load, loads } = loader();
  const refusing: JudgeModel = { judge: async () => { throw new ModelAccessError('The model cannot be used: invalid x-api-key'); } };
  const report = await runOne({ doris: doris(3), db: 'otel', load, store: q, model: refusing, runner: 'r1' }, run());
  assert.deepEqual([report.status, report.error], ['failed', 'The model cannot be used: invalid x-api-key']);
  assert.deepEqual(loads.map((l) => l.table), ['agent_judges']);
  assert.equal(calls.at(-1), 'finish 7 failed: The model cannot be used: invalid x-api-key');
  const away: JudgeModel = { judge: async () => ({ verdict: 'unsure', reason: 'The model could not be reached: 400 credit balance too low', inputTokens: 0, outputTokens: 0 }) };
  const broke = await runOne({ doris: doris(3), db: 'otel', load, store: queue().q, model: away, runner: 'r1' }, run());
  assert.deepEqual([broke.status, broke.error], ['failed', 'No call reached the model: The model could not be reached: 400 credit balance too low']);
  assert.deepEqual(loads.map((l) => l.table), ['agent_judges', 'agent_judges'], 'no unsure verdict was stored');
  // A run whose version is gone fails too.
  const gone = await runOne({ doris: doris(3), db: 'otel', load, store: queue([]).q, model, runner: 'r1' }, run());
  assert.deepEqual([gone.status, gone.error], ['failed', 'version 1 of judge edits-a1 does not exist']);
});

test('a runner whose run another runner has taken stops at once and writes no end', async () => {
  const { q, calls } = queue([V1], 1);
  const report = await runOne({ doris: doris(6), db: 'otel', load: loader().load, store: q, model, runner: 'r1', batch: 2, concurrency: 2 }, run());
  assert.deepEqual([report.status, report.judged, report.error], ['lost', 4, 'Another runner took this run over.']);
  assert.ok(!calls.some((c) => c.startsWith('finish')));
});

const judgeOf = (id: string, runsOnNew: boolean, budget: number): JudgeRecord => ({ id, name: id, currentVersion: 1, runsOnNew, budget, createdAt: '', createdBy: '' });

test('judges that follow new sessions get a run with their own budget when there are new steps and none is open', async () => {
  const enqueued: string[] = [];
  const judges = [judgeOf('edits-a1', true, 50_000), judgeOf('busy-b2', true, 1), judgeOf('once-c3', false, 1), judgeOf('race-d4', true, 9)];
  const { q } = queue();
  const store: JudgeQueue = {
    ...q, judges: async () => judges, hasOpenRun: async (id) => id === 'busy-b2',
    enqueue: async (id, scope, by, budget) => {
      if (id === 'race-d4') throw new AuthError(409, 'a run of this judge is already queued or running');
      enqueued.push(`${id} ${scope} ${by} ${budget}`);
      return run();
    },
  };
  const log: string[] = [];
  assert.equal(await queueNewSessions({ doris: doris(1, log), db: 'otel', store }), 1);
  assert.deepEqual(enqueued, ['edits-a1 new new sessions 50000']);
  assert.deepEqual(log, ['subjects (any)', 'subjects (any)']);
  assert.equal(await queueNewSessions({ doris: doris(0), db: 'otel', store }), 0, 'nothing new, nothing queued');
});

test('the job takes runs until the queue is empty', async () => {
  const { q } = queue();
  const left = [run({ id: 1 }), run({ id: 2 })];
  const store: JudgeQueue = { ...q, claim: async () => left.shift() ?? null };
  const report = await runJudges({ doris: doris(1), db: 'otel', load: loader().load, store, model, runner: 'r1' });
  assert.deepEqual([report.queued, report.runs.map((r) => [r.run, r.status])], [0, [[1, 'done'], [2, 'done']]]);
});
