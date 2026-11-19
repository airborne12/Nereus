// The risk judgment job with stubs in place of Doris, the leases and the model: each rule's judge
// judges the risks it has not judged, within one budget, and leaves a judge another runner holds.

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
          name: 'Bash', status: 'ok', target: `rm ${m[2]}`, args: null, msg_seq: 9, kind: 'tool_result', is_error: null, text: 'ok',
        }));
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 50)}`);
    },
  } as unknown as Doris;
}

/** Leases where the units in `held` are another runner's, and those in `lost` are taken over after their first take. */
function leases(held: string[] = [], lost: string[] = []) {
  const log: string[] = [];
  const take = async (job: string, unit: string) => {
    const again = log.includes(`take ${job} ${unit}`);
    log.push(`take ${job} ${unit}`);
    return !held.includes(unit) && !(again && lost.includes(unit));
  };
  return { store: { take, release: async (_job: string, unit: string) => { log.push(`release ${unit}`); } }, log };
}

function loader() {
  const loads: { table: string; rows: Record<string, unknown>[] }[] = [];
  return { load: async (table: string, _l: string, rows: readonly object[]) => { loads.push({ table, rows: rows as Record<string, unknown>[] }); return 'loaded' as const; }, loads };
}

const breach: JudgeModel = { judge: async (_m, _c, x, system) => ({ verdict: system === RISK_SYSTEM && x.includes('rm 12') ? 'violates' : 'ok', reason: 'r', inputTokens: 100, outputTokens: 5 }) };

test("each rule's judge judges the risks it has not judged, with the risk system prompt, and is published", async () => {
  const { store, log } = leases();
  const { load, loads } = loader();
  const report = await judgeRisks({ doris: doris(), db: 'otel', load, model: breach, leases: store, now: () => new Date('2026-11-19T10:00:00Z') });
  assert.deepEqual(report, { judged: 3, stopped: false, held: 0, failed: [] });
  assert.deepEqual(loads.filter((l) => l.table === 'agent_judges').map((l) => l.rows[0]!.judge), ['risk-confirm', 'risk-exfil', 'risk-subvert', 'risk-deny']);
  const judged = loads.filter((l) => l.table === 'agent_judgments').flatMap((l) => l.rows.map((r) => [r.judge, r.subject, r.verdict, r.judge_version]));
  assert.deepEqual(judged, [['risk-confirm', 's-1:confirm:12', 'violates', 1], ['risk-confirm', 's-1:confirm:40', 'ok', 1], ['risk-deny', 's-1:deny:7', 'ok', 1]]);
  assert.deepEqual(loads[0]!.rows[0], {
    judge: 'risk-confirm', version: 1, name: "Risk: Irreversible command without the user's confirmation", form: 'map', pick: { rule: 'confirm' }, reads: { kind: 'risk' },
    criterion: loads[0]!.rows[0]!.criterion, model: 'claude-haiku-5-5', created_at: '2026-11-19 00:00:00.000000', created_by: 'nereus',
  });
  assert.deepEqual(log.filter((l) => l.startsWith('take')), ['confirm', 'exfil', 'subvert', 'deny'].map((r) => `take ${RISK_JOB} risk-${r}`));
  assert.equal(log.filter((l) => l.startsWith('release')).length, 4);
});

test('a judge another runner holds is left to it', async () => {
  const { store } = leases(['risk-confirm']);
  const report = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: breach, leases: store });
  assert.deepEqual(report, { judged: 1, stopped: false, held: 1, failed: [] });
});

test('the pass stops before it would go over its budget, counting what calls have taken across the judges', async () => {
  const heavy: JudgeModel = { judge: async () => ({ verdict: 'ok', reason: 'r', inputTokens: 1_000, outputTokens: 5 }) };
  const none = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: heavy, leases: leases().store, budget: 150, concurrency: 1 });
  assert.deepEqual(none, { judged: 0, stopped: true, held: 0, failed: [] });
  const some = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: heavy, leases: leases().store, budget: 2_500, concurrency: 1 });
  assert.deepEqual(some, { judged: 2, stopped: true, held: 0, failed: [] });
});

test('a judge whose lease another runner takes over between batches stops, and the pass goes on', async () => {
  const { store, log } = leases([], ['risk-confirm']);
  const report = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: breach, leases: store, batch: 1 });
  assert.deepEqual(report, { judged: 2, stopped: false, held: 1, failed: [] });
  assert.deepEqual(log.slice(0, 3), [`take ${RISK_JOB} risk-confirm`, `take ${RISK_JOB} risk-confirm`, 'release risk-confirm']);
});

test('a model that cannot be used stops the pass and names the rule it was judging', async () => {
  const { store, log } = leases();
  const bad: JudgeModel = { judge: async () => { throw new ModelAccessError('The model cannot be used: invalid x-api-key'); } };
  const report = await judgeRisks({ doris: doris(), db: 'otel', load: loader().load, model: bad, leases: store });
  assert.deepEqual(report, { judged: 0, stopped: false, held: 0, failed: [{ rule: 'confirm', error: 'The model cannot be used: invalid x-api-key' }] });
  assert.deepEqual(log, [`take ${RISK_JOB} risk-confirm`, 'release risk-confirm']);
});

test('a budget of 0 skips the pass: no lease, no judge published, nothing read', async () => {
  const { store, log } = leases();
  const { load, loads } = loader();
  const quiet = { query: async () => { throw new Error('nothing should be read'); } } as unknown as Doris;
  assert.deepEqual(await judgeRisks({ doris: quiet, db: 'otel', load, model: breach, leases: store, budget: 0 }), { judged: 0, stopped: false, held: 0, failed: [] });
  assert.deepEqual([log, loads], [[], []]);
});
