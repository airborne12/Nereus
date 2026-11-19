// The risk judgment job (spec 6.5 and 8.6): each rule's judge judges the risks it has not judged
// with its version, so a rule finds a candidate and the model decides whether it is a breach. A
// judge is a unit of work with its own lease; one budget of input tokens covers the whole pass.

import type { Doris } from '../db/doris.ts';
import { labelFor, type Load } from '../semantics/ingest/writer.ts';
import { type JudgeModel, ModelAccessError } from '../semantics/judges/model.ts';
import { RISK_JUDGES, type RiskJudge, type RiskRef, riskReadsSql, unjudgedRisksSql } from '../semantics/judges/risk-judges.ts';
import { RISK_SYSTEM, riskExcerptsOf } from '../semantics/judges/risk-record.ts';
import { judgeExcerpts } from '../semantics/judges/runner.ts';
import { dorisTime } from '../semantics/trajectory/model.ts';
import { BATCH } from './judges.ts';
import type { LeaseStore } from './leases.ts';

export const RISK_JOB = 'risk-judgments';
/** How long a runner may hold a judge between two batches before another may take it. */
const LEASE_SECONDS = 300;
/** Input tokens one pass may spend when no budget is given. */
export const RISK_BUDGET = 200_000;

export interface RiskJudgeDeps {
  doris: Doris; db: string; load: Load; model: JudgeModel; leases: LeaseStore;
  budget?: number; batch?: number; concurrency?: number; now?: () => Date;
}
/** A judge whose judging failed, by its rule, and why. */
export interface RiskFailed { rule: string; error: string }
/** What a pass did: risks judged, whether the budget stopped it, judges another runner held, and failures. */
export interface RiskReport { judged: number; stopped: boolean; held: number; failed: RiskFailed[] }
interface Tally { judged: number; spent: number }

/** Writes a judge's version to agent_judges; writing it again changes nothing. */
async function publish(deps: RiskJudgeDeps, j: RiskJudge): Promise<void> {
  const row = { judge: j.judge, version: j.version, name: j.name, form: 'map', pick: { rule: j.rule }, reads: { kind: 'risk' }, criterion: j.criterion, model: j.model, created_at: j.createdAt, created_by: 'nereus' };
  await deps.load('agent_judges', labelFor('agent_judges', j.judge, 0, [row]), [row]);
}

const chunks = <T>(xs: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/**
 * Judges the unjudged risks of one judge a batch at a time, renewing its lease before each batch
 * after the first. Answers what it added to the pass's tally, whether the budget stopped it, and
 * whether another runner took the judge over.
 */
async function judgeOne(deps: RiskJudgeDeps, j: RiskJudge, pass: Tally, budget: number, run: string): Promise<Tally & { stopped: boolean; lost: boolean }> {
  await publish(deps, j);
  const risks: RiskRef[] = (await deps.doris.query(unjudgedRisksSql(deps.db, j).sql)).map((r) => ({ session_id: String(r.session_id), rule: String(r.rule), first_seq: Number(r.first_seq) }));
  let judged = 0;
  let spent = 0;
  for (const [i, part] of chunks(risks, deps.batch ?? BATCH).entries()) {
    if (i > 0 && !(await deps.leases.take(RISK_JOB, j.judge, LEASE_SECONDS))) return { judged, spent, stopped: false, lost: true };
    const excerpts = riskExcerptsOf(await deps.doris.query(riskReadsSql(deps.db, part).sql), part);
    const sofar = pass.judged + judged;
    let n = 0;
    const { stopped } = await judgeExcerpts(deps, j, excerpts, {
      system: RISK_SYSTEM,
      budget: budget - pass.spent - spent,
      ...(sofar ? { perCall: (pass.spent + spent) / sofar } : {}),
      onChunk: async (rows) => {
        await deps.load('agent_judgments', labelFor('agent_judgments', j.judge, i * 100 + n, rows, run), rows);
        n += 1;
        judged += rows.length;
        spent += rows.reduce((t, r) => t + r.input_tokens, 0);
      },
    });
    if (stopped) return { judged, spent, stopped: true, lost: false };
  }
  return { judged, spent, stopped: false, lost: false };
}

/**
 * One pass over the rules' judges. A judge another runner holds is left to it; a judge that fails
 * is named and the pass goes on, except when the model cannot be used, which ends the pass. A
 * budget of 0 does nothing.
 */
export async function judgeRisks(deps: RiskJudgeDeps): Promise<RiskReport> {
  const budget = deps.budget ?? RISK_BUDGET;
  // A budget of 0 turns the pass off.
  if (budget <= 0) return { judged: 0, stopped: false, held: 0, failed: [] };
  const run = dorisTime((deps.now ?? (() => new Date()))().toISOString()).replace(/\D/g, '');
  let report: RiskReport = { judged: 0, stopped: false, held: 0, failed: [] };
  let pass: Tally = { judged: 0, spent: 0 };
  for (const j of RISK_JUDGES) {
    if (!(await deps.leases.take(RISK_JOB, j.judge, LEASE_SECONDS))) {
      report = { ...report, held: report.held + 1 };
      continue;
    }
    try {
      const done = await judgeOne(deps, j, pass, budget, run);
      pass = { judged: pass.judged + done.judged, spent: pass.spent + done.spent };
      report = { ...report, judged: pass.judged, held: report.held + (done.lost ? 1 : 0) };
      if (done.stopped) return { ...report, stopped: true };
    } catch (e) {
      report = { ...report, failed: [...report.failed, { rule: j.rule, error: (e as Error).message }] };
      if (e instanceof ModelAccessError) return report;
    } finally {
      await deps.leases.release(RISK_JOB, j.judge);
    }
  }
  return report;
}
