// Judges in PostgreSQL: a new judge with its first version and run, versions that judge nothing,
// one open run per judge, the queue the runners take runs from, and writes only by the runner that
// holds a run. Skipped unless PG_TEST=1 or DORIS_TEST=1.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { AuthError } from '../src/control/auth/store.ts';
import { JudgeStore, RUN_BUDGET } from '../src/control/judges/store.ts';
import { TEMPLATES } from '../src/semantics/judges/judge.ts';
import { freshMetaDb, pgEnabled } from './meta-helper.ts';

let pool: pg.Pool;
let drop: () => Promise<void> = async () => {};
let store: JudgeStore;
const ids = ['a1b2c3', 'd4e5f6'];

before(async () => {
  if (!pgEnabled) return;
  const meta = await freshMetaDb();
  pool = meta.pool;
  drop = meta.drop;
  store = new JudgeStore(pool, () => ids.shift() ?? 'ffffff');
});
after(async () => drop());

const draft = { ...TEMPLATES.test, name: 'Edits of tests: v1!', runsOnNew: true };
const open = (e: unknown) => e instanceof AuthError && e.status === 409 && e.message === 'a run of this judge is already queued or running';

test('a new judge has version 1 and a queued run of the picked steps', { skip: !pgEnabled }, async () => {
  const { judge, run } = await store.create(draft, 'ada@example.com');
  assert.deepEqual([judge.id, judge.name, judge.currentVersion, judge.runsOnNew, judge.budget, judge.createdBy], ['edits-of-tests-v1-a1b2c3', 'Edits of tests: v1!', 1, true, RUN_BUDGET, 'ada@example.com']);
  assert.deepEqual([run.judge, run.version, run.scope, run.status, run.budget, run.judged, run.steps], [judge.id, 1, 'picked', 'queued', RUN_BUDGET, 0, null]);
  const [v] = await store.versions(judge.id);
  assert.deepEqual({ ...v, createdAt: '' }, {
    judge: judge.id, version: 1, name: 'Edits of tests: v1!', pick: draft.pick, reads: draft.reads, criterion: draft.criterion, model: draft.model, createdAt: '', createdBy: 'ada@example.com',
  });
  assert.match(v!.createdAt, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/);
  assert.deepEqual((await store.judges()).map((j) => j.id), [judge.id]);
  assert.equal(await store.judge('no-such-judge'), null);
});

test('a changed criterion or model is a new version that judges nothing; an unchanged one is refused', { skip: !pgEnabled }, async () => {
  const [judge] = await store.judges();
  const v2 = await store.addVersion(judge!.id, { criterion: 'Does the edit change only the expected value?', model: 'claude-sonnet-5-5' }, 'bo@example.com');
  assert.deepEqual([v2.version, v2.model, v2.pick, v2.reads, v2.createdBy], [2, 'claude-sonnet-5-5', draft.pick, draft.reads, 'bo@example.com']);
  assert.equal((await store.judge(judge!.id))!.currentVersion, 2);
  assert.equal((await store.runs(judge!.id)).length, 1, 'no run was queued');
  await assert.rejects(store.addVersion(judge!.id, { criterion: v2.criterion, model: v2.model }, 'bo@example.com'), /nothing changed/);
  await assert.rejects(store.addVersion('no-such-judge', { criterion: 'x', model: v2.model }, 'bo@example.com'), /no such judge/);
});

test('one open run per judge; the oldest queued run is taken once; only the runner holding a run writes to it', { skip: !pgEnabled }, async () => {
  const [judge] = await store.judges();
  await assert.rejects(store.enqueue(judge!.id, 'stale', 'bo@example.com'), open, 'the first run is still queued');
  const first = await store.claim('runner-1');
  assert.deepEqual([first?.scope, first?.status, await store.claim('runner-2')], ['picked', 'running', null]);
  assert.equal(await store.started(first!.id, 'runner-1', 12), true);
  assert.equal(await store.progress(first!.id, 'runner-1', 4, 1200, 80), true);
  assert.equal(await store.progress(first!.id, 'runner-2', 9, 9, 9), false, 'another runner cannot write to it');
  assert.equal(await store.finish(first!.id, 'runner-1', 'done'), true);
  const [done] = (await store.runs(judge!.id)).filter((r) => r.id === first!.id);
  assert.deepEqual([done!.status, done!.steps, done!.judged, done!.inputTokens, done!.outputTokens, done!.error], ['done', 12, 4, 1200, 80, null]);
  assert.ok(done!.finishedAt);

  const rerun = await store.enqueue(judge!.id, 'stale-violating', 'bo@example.com', 5000);
  assert.deepEqual([rerun.version, rerun.scope, rerun.budget], [2, 'stale-violating', 5000]);
  const second = await store.claim('runner-2');
  assert.equal(second?.id, rerun.id);
  // The second runner goes quiet; a third takes the run, and the second can no longer write to it.
  await pool.query("UPDATE judge_runs SET heartbeat_at = now() - interval '11 minutes' WHERE id = $1", [second!.id]);
  assert.equal((await store.claim('runner-3'))?.id, second!.id);
  assert.deepEqual([await store.progress(second!.id, 'runner-2', 1, 10, 1), await store.finish(second!.id, 'runner-2', 'done')], [false, false]);
  assert.equal(await store.finish(second!.id, 'runner-3', 'failed', 'The model cannot be used: bad key'), true);
  assert.equal((await store.runs(judge!.id)).find((r) => r.id === second!.id)?.error, 'The model cannot be used: bad key');
  assert.deepEqual((await store.judges()).filter((j) => j.runsOnNew).map((j) => j.id), [judge!.id]);
  assert.equal(await store.hasOpenRun(judge!.id), false);
});

test('the overview: each judge, newest first, with its current version and its last run', { skip: !pgEnabled }, async () => {
  const { judge: other } = await store.create({ ...TEMPLATES.confirm, runsOnNew: false }, 'ada@example.com', 77_000);
  assert.equal(other.budget, 77_000);
  const [first, second] = await store.overview();
  assert.deepEqual([first!.judge.id, first!.current.version, first!.current.model, first!.lastRun?.scope, first!.lastRun?.status, first!.lastRun?.budget], [other.id, 1, TEMPLATES.confirm.model, 'picked', 'queued', 77_000]);
  assert.deepEqual([second!.current.version, second!.current.model, second!.lastRun?.status, second!.lastRun?.error], [2, 'claude-sonnet-5-5', 'failed', 'The model cannot be used: bad key']);
  // Steps whose model call failed can be judged again.
  const [edits] = await store.judges();
  assert.equal((await store.enqueue(edits!.id, 'failed', 'bo@example.com')).scope, 'failed');
});
