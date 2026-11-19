// The risk judgment job with stubs in place of Doris, the leases and the model: the rules' judges
// judge the risks they have not judged a batch each in turn, within one budget, and leave a judge
// another runner holds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doris } from '../src/db/doris.ts';
import { judgeRisks, RISK_JOB } from '../src/jobs/risk-judgments.ts';
import { type JudgeModel, ModelAccessError } from '../src/semantics/judges/model.ts';
import { RISK_SYSTEM } from '../src/semantics/judges/risk-record.ts';

/** A Doris with two risks of the confirmation rule and one of the deny rule, none judged. */
function doris() {
  const risks: Record<string, number[]> = { confirm: [12, 40], deny: [7] };
  return {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT r.session_id, r.rule, r.first_seq, r.ts')) {
        const rule = /WHERE r\.rule = '(\w+)'/.exec(sql)![1]!;
        return (risks[rule] ?? []).map((first_seq) => ({ session_id: 's-1', rule, first_seq, ts: '2026-11-17 10:00:00' }));
      }
      if (sql.startsWith('WITH picked AS (\n  SELECT r.session_id, r.rule')) {
        return [...sql.matchAll(/r\.rule = '(\w+)' AND r\.first_seq = (\d+)/g)].map((m) => ({
          session_id: 's-1', rule: m[1], first_seq: Number(m[2]), rule_name: m[1], why: 'why', seq: Number(m[2]), event_kind: 'tool_call', step: 3, marked: 1,
          name: 'Bash', status: 'ok', target: `rm ${m[2]}`, args: null, msg_seq: 9, kind: 'tool_result', is_error: null, text: 'ok', session_kind: 'main',
        }));
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 50)}`);
    },
  } as unknown as Doris;
}

/** Leases where the units in `held` are another runner's, and a unit in `takes` can be taken that many times, then is another's. */
function leases(held: string[] = [], takes: Record<string, number> = {}) {
  const log: string[] = [];
  const take = async (job: string, unit: string) => {
    log.push(`take ${job} ${unit}`);
    const n = log.filter((l) => l === `take ${job} ${unit}`).length;
    return !held.includes(unit) && n <= (takes[unit] ?? Infinity);
  };
  return { store: { take, release: async (_job: string, unit: string) => { log.push(`release ${unit}`); } }, log };
}
const taken = (log: string[]) => [...new Set(log.filter((l) => l.startsWith('take')).map((l) => l.split(' ')[2]))].sort();
const released = (log: string[]) => log.filter((l) => l.startsWith('release')).map((l) => l.split(' ')[1]).sort();

function loader() {
  const loads: { table: string; rows: Record<string, unknown>[] }[] = [];
  return { load: async (table: string, _l: string, rows: readonly object[]) => { loads.push({ table, rows: rows as Record<string, unknown>[] }); return 'loaded' as const; }, loads };
}
const judgedRows = (loads: ReturnType<typeof loader>['loads']) => loads.filter((l) => l.table === 'agent_judgments').flatMap((l) => l.rows.map((r) => r.subject));

const breach: JudgeModel = { judge: async (_m, _c, x, system) => ({ verdict: system === RISK_SYSTEM && x.includes('rm 12') ? 'violates' : 'ok', reason: 'r', inputTokens: 100, outputTokens: 5 }) };
const NOTHING = { judged: 0, stopped: false, held: 0, failed: [], missed: null };

test("each rule's judge judges the risks it has not judged, with the risk system prompt, and is published", async () => {
  const { store, log } = leases();
  const { load, loads } = loader();
  const report = await judgeRisks({ doris: doris(), db: 'otel', load, model: breach, leases: store, now: () => new Date('2026-11-19T10:00:00Z') });
  assert.deepEqual(report, { ...NOTHING, judged: 3 });
  assert.deepEqual(loads.filter((l) => l.table === 'agent_judges').map((l) => l.rows[0]!.judge), ['risk-confirm', 'risk-exfil', 'risk-subvert', 'risk-deny']);
  const judged = loads.filter((l) => l.table === 'agent_judgments').flatMap((l) => l.rows.map((r) => [r.judge, r.subject, r.verdict, r.judge_version]));
  assert.deepEqual(judged, [['risk-confirm', 's-1:confirm:12', 'violates', 1], ['risk-confirm', 's-1:confirm:40', 'ok', 1], ['risk-deny', 's-1:deny:7', 'ok', 1]]);
  assert.deepEqual(loads[0]!.rows[0], {
    judge: 'risk-confirm', version: 1, name: "Risk: Irreversible command without the user's confirmation", form: 'map', pick: { rule: 'confirm' }, reads: { kind: 'risk' },
    criterion: loads[0]!.rows[0]!.criterion, model: 'claude-haiku-5-5', created_at: '2026-11-19 00:00:00.000000', created_by: 'nereus',
  });
  const all = ['confirm', 'deny', 'exfil', 'subvert'].map((r) => `risk-${r}`);
  assert.deepEqual([taken(log), released(log)], [all, all], 'every judge is taken and given back');
  assert.ok(log.every((l) => !l.startsWith('take') || l.startsWith(`take ${RISK_JOB} `)));
});

test('a judge another runner holds is left to it', async () => {
  const { store } = leases(['risk-confirm']);
  const report = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: breach, leases: store });
  assert.deepEqual(report, { ...NOTHING, judged: 1, held: 1 });
});

test('the judges take a batch each in turn, so one rule does not spend the budget of the others', async () => {
  const heavy: JudgeModel = { judge: async () => ({ verdict: 'ok', reason: 'r', inputTokens: 1_000, outputTokens: 5 }) };
  const none = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: heavy, leases: leases().store, budget: 150, concurrency: 1 });
  assert.deepEqual(none, { ...NOTHING, stopped: true });
  const { load, loads } = loader();
  const some = await judgeRisks({ doris: doris(), db: 'otel', load, model: heavy, leases: leases().store, budget: 2_500, concurrency: 1, batch: 1 });
  assert.deepEqual(some, { ...NOTHING, judged: 2, stopped: true });
  assert.deepEqual(judgedRows(loads), ['s-1:confirm:12', 's-1:deny:7']);
});

test('a judge whose lease another runner takes over between batches stops, and the pass goes on', async () => {
  const { store } = leases([], { 'risk-confirm': 3 });
  const { load, loads } = loader();
  const report = await judgeRisks({ doris: doris(), db: 'otel', load, model: breach, leases: store, batch: 1 });
  assert.deepEqual(report, { ...NOTHING, judged: 2, held: 1 });
  assert.deepEqual(judgedRows(loads), ['s-1:confirm:12', 's-1:deny:7']);
});

test('the lease is renewed after each chunk of calls, and a judge taken over within a batch stops', async () => {
  const { store } = leases([], { 'risk-confirm': 2 });
  const { load, loads } = loader();
  const report = await judgeRisks({ doris: doris(), db: 'otel', load, model: breach, leases: store, concurrency: 1 });
  assert.deepEqual(report, { ...NOTHING, judged: 2, held: 1 });
  assert.deepEqual(judgedRows(loads), ['s-1:confirm:12', 's-1:deny:7']);
});

test('a call that did not reach the model is not stored, and the pass says how many and why', async () => {
  const flaky: JudgeModel = {
    judge: async (_m, _c, x) => (x.includes('rm 40')
      ? { verdict: 'unsure', reason: 'The model could not be reached: 429 rate_limit_error', inputTokens: 0, outputTokens: 0 }
      : { verdict: 'ok', reason: 'r', inputTokens: 100, outputTokens: 5 }),
  };
  const { load, loads } = loader();
  const report = await judgeRisks({ doris: doris(), db: 'otel', load, model: flaky, leases: leases().store });
  assert.deepEqual(report, { ...NOTHING, judged: 2, missed: { calls: 1, reason: 'The model could not be reached: 429 rate_limit_error' } });
  assert.deepEqual(judgedRows(loads), ['s-1:confirm:12', 's-1:deny:7']);
});

test('a model that cannot be used stops the pass and names the rule it was judging', async () => {
  const { store, log } = leases();
  const bad: JudgeModel = { judge: async () => { throw new ModelAccessError('The model cannot be used: invalid x-api-key'); } };
  const report = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: bad, leases: store });
  assert.deepEqual(report, { ...NOTHING, failed: [{ rule: 'confirm', error: 'The model cannot be used: invalid x-api-key' }] });
  assert.deepEqual(released(log), taken(log));
});

test('a budget of 0 skips the pass: no lease, no judge published, nothing read', async () => {
  const { store, log } = leases();
  const { load, loads } = loader();
  const quiet = { query: async () => { throw new Error('nothing should be read'); } } as unknown as Doris;
  assert.deepEqual(await judgeRisks({ doris: quiet, db: 'otel', load, model: breach, leases: store, budget: 0 }), NOTHING);
  assert.deepEqual([log, loads], [[], []]);
});
