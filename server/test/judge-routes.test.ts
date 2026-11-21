// The Judges routes with stubs in place of Doris, the judge store and the model: what each route
// answers, the statements it shows, and who may write.

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { agentRoutes } from '../src/api/agents/routes.ts';
import type { User } from '../src/control/auth/store.ts';
import type { JudgeStore, RunRecord } from '../src/control/judges/store.ts';
import type { Doris } from '../src/db/doris.ts';
import { TEMPLATES, type JudgeVersion } from '../src/semantics/judges/judge.ts';
import { type JudgeModel, ModelAccessError } from '../src/semantics/judges/model.ts';

const ADMIN: User = { id: 1, email: 'ada@example.com', name: 'Ada', role: 'admin', disabled: false };
const MEMBER: User = { ...ADMIN, id: 2, email: 'bo@example.com', role: 'member' };
const JUDGE = { id: 'edits-a1b2c3', name: 'Edits', currentVersion: 2, runsOnNew: true, createdAt: '2026-11-19 08:00:00.000000', createdBy: 'ada@example.com' };
const V2: JudgeVersion = { judge: JUDGE.id, version: 2, ...TEMPLATES.test, createdAt: '2026-11-19 09:00:00.000000', createdBy: 'ada@example.com' };
const RUN: RunRecord = { id: 9, judge: JUDGE.id, version: 2, scope: 'stale', status: 'queued', budget: 2_000_000, steps: null, judged: 0, inputTokens: 0, outputTokens: 0, error: null, createdAt: '', createdBy: 'ada@example.com', startedAt: null, finishedAt: null };

/** A Doris that answers each judge statement by its shape. */
function doris() {
  const seen: string[] = [];
  const d = {
    query: async (sql: string) => {
      seen.push(sql);
      if (sql.includes('AS last_judged')) return [{ judge: JUDGE.id, judged: 40, violations: 6, sessions: 3, stale: 40, last_judged: '2026-11-19 09:30:00' }];
      if (sql.includes('AS tokens_per_step')) return [{ judged: 40, violations: 6, sessions: 3, stale: 40, stale_violating: 6, tokens_per_step: 950, failed: 2 }];
      if (sql.includes('tools_of AS')) return [{ ts: '2026-11-18 10:00:00', session_id: 's-1', seq: 21, step: 10, title: 'Fix clock', calls: 'Edit tests/a_test.py', verdict: 'violates', made_by: 1, stale: 1, reason: 'fitted', violations: 2, was: null, was_version: null }];
      if (sql.startsWith('SELECT judge_version')) return [{ judge_version: 1, verdict: 'violates', reason: 'fitted', model: 'claude-haiku-5-5', input_seqs: '[20,21,22]', input_tokens: 900, output_tokens: 30, judged_at: '2026-11-18 11:00:00' }];
      if (sql.includes('AS steps, count(DISTINCT session_id) AS sessions')) return [{ steps: 120, sessions: 9 }];
      if (sql.includes('ranked AS')) return [{ session_id: 's-1', seq: 21, ts: '2026-11-18 10:00:00', turn: 2, step: 10 }];
      if (sql.startsWith('WITH judged AS')) return [{ session_id: 's-1', judged: 21, seq: 21, event_kind: 'llm_call', step: 10, name: null, status: 'ok', target: '', msg_seq: 1, kind: 'text', is_error: null, text: 'Changing the expected date.' }];
      return [];
    },
  } as unknown as Doris;
  return { d, seen };
}

function store() {
  const calls: string[] = [];
  const s = {
    overview: async () => [{ judge: JUDGE, current: V2, lastRun: RUN }],
    judge: async (id: string) => (id === JUDGE.id ? JUDGE : null),
    versions: async () => [{ ...V2, version: 1 }, V2],
    runs: async () => [RUN],
    create: async (draft: unknown, by: string, budget?: number) => { calls.push(`create ${JSON.stringify(draft)} ${by} ${budget}`); return { judge: JUDGE, run: RUN }; },
    addVersion: async (id: string, change: unknown, by: string) => { calls.push(`version ${id} ${JSON.stringify(change)} ${by}`); return V2; },
    enqueue: async (id: string, scope: string, by: string, budget?: number) => { calls.push(`enqueue ${id} ${scope} ${by} ${budget}`); return RUN; },
  } as unknown as JudgeStore;
  return { s, calls };
}

const model: JudgeModel = { judge: async () => ({ verdict: 'violates', reason: 'It changes the expected date.', inputTokens: 900, outputTokens: 20 }) };

function call(o: { d: Doris; s: JudgeStore; m?: JudgeModel }, method: string, path: string, user: User, body?: unknown) {
  const answers: { status: number; body: any }[] = [];
  const routes = agentRoutes({ doris: o.d, db: 'otel', send: (_res, status, b) => answers.push({ status, body: b }), judges: { store: o.s, model: o.m ?? model } });
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
  const res = { writeHead: () => res, end: () => undefined } as unknown as ServerResponse;
  return { done: routes.handle(req, res, new URL(`http://x${path}`), user), answers };
}

test('the list: each judge with its current version, last run and counts, and the statement behind the counts', async () => {
  const { d, seen } = doris();
  const c = call({ d, s: store().s }, 'GET', '/api/agents/judges', MEMBER);
  assert.equal(await c.done, true);
  const [row] = c.answers[0]!.body.rows;
  assert.deepEqual([row.id, row.version, row.model, row.pickText, row.lastRun.id, row.judged, row.violations, row.sessions, row.stale, row.lastJudged], [JUDGE.id, 2, 'claude-haiku-5-5', 'Edit or Write calls on "test"', 9, 40, 6, 3, 40, '2026-11-19 09:30:00']);
  assert.deepEqual(c.answers[0]!.body.sql.map((s: any) => s.title), ['Judges']);
  assert.equal(seen.length, 1);
});

test('a judge in a view: versions, runs, counts with the rerun estimate, and the rows of the view', async () => {
  const { d } = doris();
  const c = call({ d, s: store().s }, 'GET', `/api/agents/judges/${JUDGE.id}?view=all`, MEMBER);
  await c.done;
  const b = c.answers[0]!.body;
  assert.deepEqual([b.view, b.versions.length, b.runs.length, b.counts, b.rows[0].calls, b.sql.map((s: any) => s.title)],
    ['all', 2, 1, { judged: 40, violations: 6, sessions: 3, stale: 40, staleViolating: 6, tokensPerStep: 950, failed: 2 }, 'Edit tests/a_test.py', ['Verdicts', 'All verdicts']]);
  assert.equal(b.readsText, "the user's request of the turn, and the 3 steps before the judged one");
  assert.equal(b.cut, false);
  const missing = call({ d, s: store().s }, 'GET', '/api/agents/judges/no-such-judge', MEMBER);
  await missing.done;
  assert.equal(missing.answers[0]!.status, 404);
  await assert.rejects(call({ d, s: store().s }, 'GET', `/api/agents/judges/${JUDGE.id}?view=some`, MEMBER).done, /'view' must be first, all or changed/);
});

test('a view is cut at 500 rows and says so', async () => {
  const { d } = doris();
  const row = (i: number) => ({ ts: '2026-11-18 10:00:00', session_id: `s-${i}`, seq: i, step: 1, verdict: 'ok', made_by: 2, stale: 0, reason: 'fine' });
  const many = { query: async (sql: string) => (sql.includes('tools_of AS') ? Array.from({ length: 501 }, (_, i) => row(i)) : d.query(sql)) } as unknown as Doris;
  const c = call({ d: many, s: store().s }, 'GET', `/api/agents/judges/${JUDGE.id}?view=all`, MEMBER);
  await c.done;
  const b = c.answers[0]!.body;
  assert.deepEqual([b.rows.length, b.cut, b.rows.at(-1).session_id], [500, true, 's-499']);
});

test('the verdicts of one step, with what the model reads for it now', async () => {
  const { d } = doris();
  const c = call({ d, s: store().s }, 'GET', `/api/agents/judges/${JUDGE.id}/steps/s-1/21`, MEMBER);
  await c.done;
  const b = c.answers[0]!.body;
  assert.deepEqual(b.verdicts[0].input_seqs, [20, 21, 22]);
  assert.equal(b.read, '<step judged="true">\nAssistant: Changing the expected date.\n</step>');
  assert.deepEqual(b.sql.map((s: any) => s.title), ['Verdicts of the step', 'What the model reads']);
});

test('a preview counts the picked steps, reads a sample, estimates the run; a try asks the model and is for admins', async () => {
  const { d } = doris();
  const body = { pick: TEMPLATES.test.pick, reads: TEMPLATES.test.reads, criterion: TEMPLATES.test.criterion, model: 'claude-haiku-5-5' };
  const look = call({ d, s: store().s }, 'POST', '/api/agents/judges/preview', MEMBER, body);
  await look.done;
  const b = look.answers[0]!.body;
  assert.deepEqual([b.steps, b.sessions, b.sample.length, b.sample[0].verdict, b.sql.map((s: any) => s.title)], [120, 9, 1, undefined, ['Steps to judge', 'Steps to try', 'What the model reads']]);
  assert.ok(b.estimate > 120 * 100 && b.estimate < 120 * 400, `${b.estimate}`);
  await assert.rejects(call({ d, s: store().s }, 'POST', '/api/agents/judges/preview', MEMBER, { ...body, try: true }).done, /only admins/);
  const tried = call({ d, s: store().s }, 'POST', '/api/agents/judges/preview', ADMIN, { ...body, try: true });
  await tried.done;
  assert.deepEqual([tried.answers[0]!.body.sample[0].verdict, tried.answers[0]!.body.sample[0].reason], ['violates', 'It changes the expected date.']);
  const refused: JudgeModel = { judge: async () => { throw new ModelAccessError('The model cannot be used: invalid x-api-key'); } };
  const noKey = call({ d, s: store().s, m: refused }, 'POST', '/api/agents/judges/preview', ADMIN, { ...body, try: true });
  await noKey.done;
  assert.deepEqual(noKey.answers[0], { status: 503, body: { error: 'The model cannot be used: invalid x-api-key' } });
});

test('admins save a judge, a version or a rerun; members may not', async () => {
  const { d } = doris();
  const { s, calls } = store();
  const draft = { ...TEMPLATES.confirm, runsOnNew: true };
  await assert.rejects(call({ d, s }, 'POST', '/api/agents/judges', MEMBER, draft).done, /only admins/);
  const made = call({ d, s }, 'POST', '/api/agents/judges', ADMIN, { ...draft, budget: 50_000 });
  await made.done;
  assert.deepEqual([made.answers[0]!.status, made.answers[0]!.body.run.id], [201, 9]);
  await assert.rejects(call({ d, s }, 'POST', '/api/agents/judges', ADMIN, { ...draft, budget: 0 }).done, /budget must be a whole number/);
  await assert.rejects(call({ d, s }, 'POST', '/api/agents/judges', ADMIN, { ...draft, name: '' }).done, /name must not be empty/);
  await call({ d, s }, 'POST', `/api/agents/judges/${JUDGE.id}/versions`, ADMIN, { criterion: 'Is it cut?', model: 'claude-sonnet-5-5' }).done;
  await call({ d, s }, 'POST', `/api/agents/judges/${JUDGE.id}/reruns`, ADMIN, { only: 'violates' }).done;
  await call({ d, s }, 'POST', `/api/agents/judges/${JUDGE.id}/reruns`, ADMIN, { only: 'all', budget: 9000 }).done;
  // The steps a stopped or failed run left, and the steps whose model call failed, can be judged again.
  await call({ d, s }, 'POST', `/api/agents/judges/${JUDGE.id}/reruns`, ADMIN, { only: 'unjudged' }).done;
  await call({ d, s }, 'POST', `/api/agents/judges/${JUDGE.id}/reruns`, ADMIN, { only: 'failed' }).done;
  await assert.rejects(call({ d, s }, 'POST', `/api/agents/judges/${JUDGE.id}/reruns`, ADMIN, { only: 'some' }).done, /'only' must be all, violates, unjudged or failed/);
  assert.deepEqual(calls.map((x) => x.replace(/\{.*\}/, '{…}')), [
    'create {…} ada@example.com 50000', `version ${JUDGE.id} {…} ada@example.com`, `enqueue ${JUDGE.id} stale-violating ada@example.com undefined`, `enqueue ${JUDGE.id} stale ada@example.com 9000`,
    `enqueue ${JUDGE.id} picked ada@example.com undefined`, `enqueue ${JUDGE.id} failed ada@example.com undefined`,
  ]);
  assert.match(calls[0]!, /"criterion":"Does this step run a command that cannot be undone/);
});

test('the templates and models a new judge starts from', async () => {
  const c = call({ d: doris().d, s: store().s }, 'GET', '/api/agents/judges/templates', MEMBER);
  await c.done;
  const b = c.answers[0]!.body;
  assert.deepEqual([Object.keys(b.templates), b.models, b.defaultModel, b.budget], [['test', 'confirm'], ['claude-haiku-5-5', 'claude-sonnet-5-5', 'gemini-3.5-flash'], 'claude-haiku-5-5', 2_000_000]);
  assert.equal(b.templates.confirm.pick.tool, 'Bash');
});

test('a server without judges says so; an unknown judge path is not found', async () => {
  const answers: { status: number; body: any }[] = [];
  const routes = agentRoutes({ doris: doris().d, db: 'otel', send: (_r, status, body) => answers.push({ status, body }) });
  const res = {} as ServerResponse;
  await routes.handle({ method: 'GET', headers: {} } as IncomingMessage, res, new URL('http://x/api/agents/judges'), MEMBER);
  assert.deepEqual(answers[0], { status: 503, body: { error: 'judges are not set up on this server' } });
  const c = call({ d: doris().d, s: store().s }, 'DELETE', `/api/agents/judges/${JUDGE.id}`, ADMIN);
  await c.done;
  assert.equal(c.answers[0]!.status, 404);
});
