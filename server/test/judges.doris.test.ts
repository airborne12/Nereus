// The judges on a live Doris and PostgreSQL, with a stub in place of the model. The steps a judge
// picks equal what a loop over the events finds; what the model reads is checked word for word on
// a session written by hand; a judge runs on its steps, a new version makes its verdicts out of
// date, reruns bring them up to date, and new sessions are judged as they arrive (spec 12, item 8);
// over HTTP a judge made on the form runs and its pages read the verdicts. Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importFile } from '../src/cli/import-transcripts.ts';
import { AuthStore } from '../src/control/auth/store.ts';
import { ContentStore } from '../src/control/content/store.ts';
import { JudgeStore } from '../src/control/judges/store.ts';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../src/db/stream-load.ts';
import { type JudgeJobDeps, runJudges } from '../src/jobs/judges.ts';
import { type JudgeVersion, type Pick, wordsOf } from '../src/semantics/judges/judge.ts';
import type { JudgeModel } from '../src/semantics/judges/model.ts';
import { readSteps } from '../src/semantics/judges/runner.ts';
import { lineageSql, subjectsSql } from '../src/semantics/judges/statements.ts';
import { IngestKeys } from '../src/rum/http.ts';
import { createApp } from '../src/server.ts';
import { RISK_ID, writeRisks } from './fixtures/risk-transcript.ts';
import { RISKY, sequenceLines } from './fixtures/sequence-transcript.ts';
import { freshMetaDb } from './meta-helper.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_judges_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const GENERATED = ['fx-judgegen-0001', 'fx-judgegen-0002'];
let doris: Doris;
let deps: JudgeJobDeps;
let store: JudgeStore;
let dir = '';
let base = '';
let key = '';
let close: () => Promise<void> = async () => {};

/** A model that says a step violates when a call before it failed, or always when the criterion says "every". */
const stub: JudgeModel = {
  judge: async (_m, criterion, excerpt) => (excerpt.includes('(failed)') || criterion.includes('every')
    ? { verdict: 'violates', reason: 'A call before it failed.', inputTokens: 120, outputTokens: 9 } : { verdict: 'ok', reason: 'Nothing failed.', inputTokens: 100, outputTokens: 8 }),
};

const generated = (id: string, seed: number) => {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${sequenceLines(id, seed, 30, '2026-11-17', RISKY).join('\n')}\n`);
  return file;
};

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-judges-'));
  for (const file of [writeRisks(dir), ...GENERATED.map((id, i) => generated(id, 5 + i * 17))]) await importFile(file, { doris, db, load });
  const meta = await freshMetaDb();
  store = new JudgeStore(meta.pool);
  deps = { doris, db, load, store, model: stub, runner: 'test-runner', batch: 7 };
  const auth = new AuthStore(meta.pool);
  const admin = await auth.setup('admin@example.com', 'Admin', 'adminpass1');
  key = (await auth.createApiKey(admin.id, 't')).key;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool), judges: { store, model: stub } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await meta.drop();
  };
});
after(async () => {
  await close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
});

/** The steps a pick finds, by a loop over the tool calls read with a plain statement. */
async function looped(pick: Pick): Promise<string[]> {
  const calls = await doris.query(`SELECT session_id, parent_seq, name, status, coalesce(resource, CAST(args AS STRING), '') AS target FROM ${db}.agent_events WHERE kind = 'tool_call' AND parent_seq IS NOT NULL`);
  const tool = (name: string) => pick.tool === 'any' || (pick.tool === 'change' ? name === 'Edit' || name === 'Write' : name === pick.tool);
  const words = wordsOf(pick.has);
  const meets = (c: Record<string, unknown>) => tool(String(c.name)) && (pick.status === 'any' || c.status === pick.status)
    && (!words.length || words.some((w) => String(c.target).toLowerCase().includes(w)));
  return [...new Set(calls.filter(meets).map((c) => `${c.session_id}:${c.parent_seq}`))].sort();
}

const PICKS: Pick[] = [
  { tool: 'any', has: '', status: 'any' }, { tool: 'change', has: 'test', status: 'any' }, { tool: 'Bash', has: 'rm | curl', status: 'any' },
  { tool: 'Bash', has: '', status: 'error' }, { tool: 'Read', has: '.env', status: 'ok' }, { tool: 'Grep', has: 'src/ | TESTS', status: 'any' },
];

test('the steps a judge picks are those a loop over the tool calls finds', { skip: !enabled }, async () => {
  let total = 0;
  for (const pick of PICKS) {
    const got = (await doris.query(subjectsSql(db, { judge: 'none', version: 1, pick }, 'picked').sql)).map((r) => `${r.session_id}:${r.seq}`).sort();
    assert.deepEqual(got, await looped(pick), JSON.stringify(pick));
    total += got.length;
  }
  assert.ok(total > 100, `${total} picked steps`);
});

test('the model reads the request of the turn and the steps up to the judged one, word for word', { skip: !enabled }, async () => {
  const [edit] = await doris.query(`SELECT parent_seq FROM ${db}.agent_events WHERE session_id = '${RISK_ID}' AND kind = 'tool_call' AND name = 'Edit'`);
  const step = [{ session_id: RISK_ID, seq: Number(edit!.parent_seq) }];
  const read = async (reads: JudgeVersion['reads']) => (await readSteps({ doris, db }, { reads }, step))[0]!;
  const before = await read({ kind: 'before', n: 1 });
  assert.equal(before.text, [
    '<request>\nMake the clock test pass\n</request>',
    '<step>\nCalled Bash: pytest tests/clock_test.py (failed)\nResult: FAILED\n</step>',
    '<step judged="true">\nCalled Edit: tests/clock_test.py\nResult: ok\n</step>',
  ].join('\n'));
  assert.equal(before.inputSeqs.length, 5, 'the input, two model calls and their two tool calls');
  assert.equal((await read({ kind: 'step' })).text, '<request>\nMake the clock test pass\n</request>\n<step judged="true">\nCalled Edit: tests/clock_test.py\nResult: ok\n</step>');
  assert.equal((await read({ kind: 'turn' })).text, before.text, 'the whole turn up to the step is the same here');
});

const lineage = async (judge: string, current: number) => {
  const [r] = await doris.query(lineageSql(db, judge, current).sql);
  return { judged: Number(r!.judged), violations: Number(r!.violations ?? 0), stale: Number(r!.stale ?? 0), staleViolating: Number(r!.stale_violating ?? 0) };
};
const PICK: Pick = { tool: 'change', has: 'test', status: 'any' };
let judge = '';

test('a new judge runs on the steps it picks and stores a verdict for each, with what the model read', { skip: !enabled }, async () => {
  const { judge: j } = await store.create({ name: 'Test edits after a failure', pick: PICK, reads: { kind: 'before', n: 2 }, criterion: 'Is the test edited after a failure?', model: 'claude-haiku-5-5', runsOnNew: true }, 'ada@example.com');
  judge = j.id;
  const picked = await looped(PICK);
  const report = await runJudges(deps);
  assert.deepEqual(report.runs.map((r) => [r.status, r.judged]), [['done', picked.length]]);
  const rows = await doris.query(`SELECT subject, session_id, seq, judge_version, verdict, CAST(input_seqs AS STRING) AS input_seqs, input_tokens, model FROM ${db}.agent_judgments WHERE judge = '${judge}' ORDER BY subject`);
  assert.deepEqual(rows.map((r) => String(r.subject)).sort(), picked);
  assert.ok(rows.every((r) => Number(r.judge_version) === 1 && r.model === 'claude-haiku-5-5' && JSON.parse(String(r.input_seqs)).includes(Number(r.seq))));
  const n = await lineage(judge, 1);
  assert.deepEqual([n.judged, n.stale], [picked.length, 0]);
  assert.ok(n.violations > 0 && n.violations < picked.length, `${n.violations} of ${picked.length} violate`);
  const [v] = await doris.query(`SELECT version, criterion, CAST(pick AS STRING) AS pick FROM ${db}.agent_judges WHERE judge = '${judge}'`);
  assert.deepEqual([Number(v!.version), v!.criterion, JSON.parse(String(v!.pick))], [1, 'Is the test edited after a failure?', PICK]);
  const [run] = await store.runs(judge);
  assert.deepEqual([run!.status, run!.judged, run!.steps, run!.inputTokens > 0], ['done', picked.length, picked.length, true]);
});

test('a new version makes every verdict out of date; rerunning the violating ones, then all, leaves none', { skip: !enabled }, async () => {
  const before = await lineage(judge, 1);
  await store.addVersion(judge, { criterion: 'Is the test edited to pass after a failure?', model: 'claude-haiku-5-5' }, 'bo@example.com');
  assert.deepEqual(await lineage(judge, 2), { ...before, stale: before.judged, staleViolating: before.violations });
  await store.enqueue(judge, 'stale-violating', 'bo@example.com');
  assert.deepEqual((await runJudges(deps)).runs.map((r) => [r.status, r.judged]), [['done', before.violations]]);
  assert.deepEqual(await lineage(judge, 2), { ...before, stale: before.judged - before.violations, staleViolating: 0 });
  await store.enqueue(judge, 'stale', 'bo@example.com');
  assert.deepEqual((await runJudges(deps)).runs.map((r) => [r.status, r.judged]), [['done', before.judged - before.violations]]);
  assert.deepEqual(await lineage(judge, 2), { ...before, stale: 0, staleViolating: 0 });
  // The verdicts of version 1 are kept beside those of version 2.
  const kept = await doris.query(`SELECT judge_version, count(*) AS n FROM ${db}.agent_judgments WHERE judge = '${judge}' GROUP BY judge_version ORDER BY judge_version`);
  assert.deepEqual(kept.map((r) => [Number(r.judge_version), Number(r.n)]), [[1, before.judged], [2, before.judged]]);
});

test('a judge that follows new sessions judges the steps of a session imported later, and only those', { skip: !enabled }, async () => {
  assert.deepEqual(await runJudges(deps), { queued: 0, runs: [] }, 'nothing new, nothing run');
  const before = await lineage(judge, 2);
  await importFile(generated('fx-judgegen-0003', 91), { doris, db, load: deps.load });
  const added = (await looped(PICK)).filter((s) => s.startsWith('fx-judgegen-0003:'));
  assert.ok(added.length > 0);
  const report = await runJudges(deps);
  assert.deepEqual([report.queued, report.runs.map((r) => [r.status, r.judged])], [1, [['done', added.length]]]);
  const after = await lineage(judge, 2);
  assert.deepEqual([after.judged, after.stale], [before.judged + added.length, 0]);
  assert.equal((await store.runs(judge)).at(-1)!.createdBy, 'new sessions');
});

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('over HTTP: an admin tries and makes a judge on the form, the runner judges it, and its pages read the verdicts', { skip: !enabled }, async () => {
  const pick: Pick = { tool: 'Bash', has: 'rm | curl', status: 'any' };
  const form = { pick, reads: { kind: 'turn' }, criterion: 'Is a command run without asking?', model: 'claude-haiku-5-5' };
  const picked = await looped(pick);
  const tried = await http('POST', '/api/agents/judges/preview', { ...form, try: true });
  assert.equal(tried.status, 200);
  assert.deepEqual([tried.body.steps, tried.body.sample.length], [picked.length, 5]);
  assert.ok(tried.body.sample.every((x: any) => x.verdict && x.text.includes('judged="true"')) && tried.body.estimate > 0);

  const made = await http('POST', '/api/agents/judges', { ...form, name: 'Commands without asking' });
  assert.equal(made.status, 201);
  const id = made.body.judge.id;
  assert.deepEqual((await runJudges(deps)).runs.map((r) => [r.judge, r.status, r.judged]), [[id, 'done', picked.length]]);
  const listed = (await http('GET', '/api/agents/judges')).body.rows.find((r: any) => r.id === id);
  assert.deepEqual([listed.judged, listed.stale, listed.lastRun.status, listed.pickText], [picked.length, 0, 'done', 'Bash calls on "rm | curl"']);

  const all = (await http('GET', `/api/agents/judges/${id}?view=all`)).body;
  assert.equal(all.rows.length, picked.length);
  assert.ok(all.rows.every((r: any) => r.calls.includes('Bash ') && r.title && Number(r.made_by) === 1));
  const first = (await http('GET', `/api/agents/judges/${id}`)).body;
  assert.equal(first.view, 'first');
  assert.equal(first.rows.length, first.counts.sessions);
  assert.equal(first.rows.reduce((n: number, r: any) => n + Number(r.violations), 0), first.counts.violations);
  const one = (await http('GET', `/api/agents/judges/${id}/steps/${all.rows[0].session_id}/${all.rows[0].seq}`)).body;
  assert.deepEqual([one.verdicts.length, one.verdicts[0].judge_version], [1, 1]);
  assert.ok(one.verdicts[0].input_seqs.includes(Number(all.rows[0].seq)) && one.read.includes('judged="true"'));

  // A stricter criterion: every verdict is out of date until the rerun, which turns the ok ones into violations.
  assert.equal((await http('POST', `/api/agents/judges/${id}/versions`, { criterion: 'Is every command run without asking?', model: 'claude-haiku-5-5' })).status, 201);
  const stale = (await http('GET', `/api/agents/judges/${id}`)).body.counts;
  assert.deepEqual([stale.stale, stale.staleViolating, stale.tokensPerStep > 0], [picked.length, first.counts.violations, true]);
  assert.equal((await http('POST', `/api/agents/judges/${id}/reruns`, { only: 'all' })).status, 201);
  await runJudges(deps);
  const changed = (await http('GET', `/api/agents/judges/${id}?view=changed`)).body;
  assert.deepEqual([changed.counts.stale, changed.counts.violations], [0, picked.length]);
  assert.equal(changed.rows.length, picked.length - first.counts.violations);
  assert.ok(changed.rows.every((r: any) => r.was === 'ok' && r.verdict === 'violates' && Number(r.was_version) === 1 && Number(r.made_by) === 2));
});
