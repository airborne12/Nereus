// The risk judgment job (spec 6.5 and 8.6): each rule's judge judges the risks it has not judged
// with its version, so a rule finds a candidate and the model decides whether it is a breach. A
// judge is a unit of work with its own lease; the judges take a batch each in turn, and one budget
// of input tokens covers the whole pass.

import type { Doris } from '../db/doris.ts';
import { labelFor, type Load } from '../semantics/ingest/writer.ts';
import { type JudgeModel, ModelAccessError } from '../semantics/judges/model.ts';
import { RISK_JUDGES, type RiskJudge, type RiskRef, riskReadsSql, unjudgedRisksSql } from '../semantics/judges/risk-judges.ts';
import { RISK_SYSTEM, riskExcerptsOf } from '../semantics/judges/risk-record.ts';
import { judgeExcerpts, type JudgmentRow } from '../semantics/judges/runner.ts';
import { dorisTime } from '../semantics/trajectory/model.ts';
import { BATCH } from './judges.ts';
import type { LeaseStore } from './leases.ts';

export const RISK_JOB = 'risk-judgments';
/** How long a runner may hold a judge between two renewals before another may take it. */
const LEASE_SECONDS = 300;
/** Input tokens one pass may spend when no budget is given. */
export const RISK_BUDGET = 200_000;

export interface RiskJudgeDeps {
  doris: Doris; db: string; load: Load; model: JudgeModel; leases: LeaseStore;
  budget?: number; batch?: number; concurrency?: number; now?: () => Date;
}
/** A judge whose judging failed, by its rule, and why. */
export interface RiskFailed { rule: string; error: string }
/** Calls that did not reach the model, and the reason of the first; their risks are tried again on the next pass. */
export interface Missed { calls: number; reason: string }
/** What a pass did: risks judged, whether the budget stopped it, judges another runner held, failures, and calls that did not reach the model. */
export interface RiskReport { judged: number; stopped: boolean; held: number; failed: RiskFailed[]; missed: Missed | null }
interface Tally { judged: number; spent: number }
/** A judge this runner holds, with the risks it has still to judge and the batches it has judged. */
interface Open { judge: RiskJudge; risks: RiskRef[]; batches: number }
interface Done extends Tally { missed: Missed | null; stopped: boolean; lost: boolean }

const EMPTY: RiskReport = { judged: 0, stopped: false, held: 0, failed: [], missed: null };

class LostLease extends Error {}

/** Whether a row holds the model's answer: a call that did not reach the model is unsure and took no input tokens. */
const answered = (r: JudgmentRow): boolean => !(r.verdict === 'unsure' && r.input_tokens === 0);

const addMissed = (a: Missed | null, b: Missed | null): Missed | null => (a && b ? { calls: a.calls + b.calls, reason: a.reason } : a ?? b);

const renew = (deps: RiskJudgeDeps, j: RiskJudge): Promise<boolean> => deps.leases.take(RISK_JOB, j.judge, LEASE_SECONDS);

/** Writes a judge's version to agent_judges; writing it again changes nothing. */
async function publish(deps: RiskJudgeDeps, j: RiskJudge): Promise<void> {
  const row = { judge: j.judge, version: j.version, name: j.name, form: 'map', pick: { rule: j.rule }, reads: { kind: 'risk' }, criterion: j.criterion, model: j.model, created_at: j.createdAt, created_by: 'nereus' };
  await deps.load('agent_judges', labelFor('agent_judges', j.judge, 0, [row]), [row]);
}

async function unjudged(deps: RiskJudgeDeps, j: RiskJudge): Promise<RiskRef[]> {
  return (await deps.doris.query(unjudgedRisksSql(deps.db, j).sql)).map((r) => ({ session_id: String(r.session_id), rule: String(r.rule), first_seq: Number(r.first_seq) }));
}

/**
 * Judges the next batch of one judge. The lease is renewed before the batch and after each chunk
 * of calls; when another runner has taken the judge, it stops with what it stored. The row of a
 * call that did not reach the model is not stored, so its risk is tried again.
 */
async function judgeBatch(deps: RiskJudgeDeps, o: Open, pass: Tally, budget: number, run: string): Promise<Done> {
  const j = o.judge;
  let judged = 0;
  let spent = 0;
  let missed: Missed | null = null;
  if (!(await renew(deps, j))) return { judged, spent, missed, stopped: false, lost: true };
  const part = o.risks.slice(0, deps.batch ?? BATCH);
  const excerpts = riskExcerptsOf(await deps.doris.query(riskReadsSql(deps.db, part).sql), part);
  let n = 0;
  try {
    const { stopped } = await judgeExcerpts(deps, j, excerpts, {
      system: RISK_SYSTEM,
      budget: budget - pass.spent,
      ...(pass.judged ? { perCall: pass.spent / pass.judged } : {}),
      onChunk: async (rows) => {
        const kept = rows.filter(answered);
        const failed = rows.filter((r) => !answered(r));
        if (failed.length) missed = addMissed(missed, { calls: failed.length, reason: failed[0]!.reason });
        if (kept.length) await deps.load('agent_judgments', labelFor('agent_judgments', j.judge, o.batches * 100 + n, kept, run), kept);
        n += 1;
        judged += kept.length;
        spent += rows.reduce((t, r) => t + r.input_tokens, 0);
        if (!(await renew(deps, j))) throw new LostLease();
      },
    });
    return { judged, spent, missed, stopped, lost: false };
  } catch (e) {
    if (e instanceof LostLease) return { judged, spent, missed, stopped: false, lost: true };
    throw e;
  }
}

/** Takes, publishes and lists each judge that another runner does not hold. */
async function openJudges(deps: RiskJudgeDeps): Promise<{ taken: RiskJudge[]; open: Open[]; report: RiskReport }> {
  let taken: RiskJudge[] = [];
  let open: Open[] = [];
  let report = EMPTY;
  for (const j of RISK_JUDGES) {
    if (!(await renew(deps, j))) {
      report = { ...report, held: report.held + 1 };
      continue;
    }
    taken = [...taken, j];
    try {
      await publish(deps, j);
      const risks = await unjudged(deps, j);
      if (risks.length) open = [...open, { judge: j, risks, batches: 0 }];
    } catch (e) {
      report = { ...report, failed: [...report.failed, { rule: j.rule, error: (e as Error).message }] };
    }
  }
  return { taken, open, report };
}

/**
 * One pass over the rules' judges: a batch of each judge in turn, newest risks first, until every
 * risk is judged or the budget stops it. A judge another runner holds is left to it; a judge that
 * fails is named and the pass goes on, except when the model cannot be used, which ends the pass.
 * A budget of 0 does nothing.
 */
export async function judgeRisks(deps: RiskJudgeDeps): Promise<RiskReport> {
  const budget = deps.budget ?? RISK_BUDGET;
  // A budget of 0 turns the pass off.
  if (budget <= 0) return EMPTY;
  const run = dorisTime((deps.now ?? (() => new Date()))().toISOString()).replace(/\D/g, '');
  const size = deps.batch ?? BATCH;
  const start = await openJudges(deps);
  let { open, report } = start;
  let pass: Tally = { judged: 0, spent: 0 };
  try {
    while (open.length) {
      let next: Open[] = [];
      for (const o of open) {
        try {
          const done = await judgeBatch(deps, o, pass, budget, run);
          pass = { judged: pass.judged + done.judged, spent: pass.spent + done.spent };
          report = { ...report, judged: pass.judged, held: report.held + (done.lost ? 1 : 0), missed: addMissed(report.missed, done.missed) };
          if (done.stopped) return { ...report, stopped: true };
          if (!done.lost && o.risks.length > size) next = [...next, { ...o, risks: o.risks.slice(size), batches: o.batches + 1 }];
        } catch (e) {
          report = { ...report, failed: [...report.failed, { rule: o.judge.rule, error: (e as Error).message }] };
          if (e instanceof ModelAccessError) return report;
        }
      }
      open = next;
    }
    return report;
  } finally {
    for (const j of start.taken) await deps.leases.release(RISK_JOB, j.judge);
  }
}
