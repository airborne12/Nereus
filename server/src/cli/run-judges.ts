// Runs the judges: queues a run for each judge that follows new sessions and has new steps, takes
// queued runs until none is left, then judges the safety risks the rules' judges have not judged,
// then the reads of memories the validity fold has not judged. Verdicts and states go to
// agent_judgments; runs and leases are kept in the metadata database (META_DATABASE_URL).
//
//   node src/cli/run-judges.ts
//
// A model named gemini-* is reached with GEMINI_API_KEY, any other through the Anthropic SDK
// (ANTHROPIC_API_KEY). JUDGE_MODEL names the model of the judges kept in code (the risk judges and
// the validity fold). RISK_JUDGE_BUDGET and MEMORY_JUDGE_BUDGET cap the input tokens of the risk
// pass and of the memory pass; 0 skips one. A run, a risk judge or a memory that fails is named and
// the command exits with 1.

import { hostname } from 'node:os';
import { JudgeStore } from '../control/judges/store.ts';
import { Doris, configFromEnv } from '../db/doris.ts';
import { metaPoolFromEnv, migrate } from '../db/meta.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { type RunReport, runJudges } from '../jobs/judges.ts';
import { Leases } from '../jobs/leases.ts';
import { judgeRisks, type Missed, RISK_BUDGET, type RiskReport } from '../jobs/risk-judgments.ts';
import { judgeMemories, VALIDITY_BUDGET, type ValidityReport } from '../jobs/validity.ts';
import { MODELS } from '../semantics/judges/judge.ts';
import { modelsFromEnv } from '../semantics/judges/providers.ts';

/** A budget of input tokens from the environment variable `name`, or `fallback` when it is not set. */
function envBudget(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d{1,12}$/.test(raw)) throw new Error(`${name} must be a whole number of input tokens`);
  return Number(raw);
}

/** The input tokens the risk pass may spend, from RISK_JUDGE_BUDGET. */
export const riskBudget = (env: Record<string, string | undefined>): number => envBudget(env, 'RISK_JUDGE_BUDGET', RISK_BUDGET);
/** The input tokens the memory pass may spend, from MEMORY_JUDGE_BUDGET. */
export const memoryBudget = (env: Record<string, string | undefined>): number => envBudget(env, 'MEMORY_JUDGE_BUDGET', VALIDITY_BUDGET);

/** The model of the judges kept in code, from JUDGE_MODEL; unset keeps the model each has in code. */
export function judgeModelOf(env: Record<string, string | undefined>): string | undefined {
  const raw = env.JUDGE_MODEL;
  if (raw === undefined) return undefined;
  if (!(MODELS as readonly string[]).includes(raw)) throw new Error(`JUDGE_MODEL must be one of ${MODELS.join(', ')}`);
  return raw;
}

const missedLine = (what: string, m: Missed | null | undefined): string[] =>
  m ? [`${m.calls} ${what} call(s) did not reach the model and will be tried again on the next pass: ${m.reason}`] : [];

/** What the command prints: one line, then one line per run that did not finish, and per stop, missed calls, calls without a judgment and failure of the risk and memory passes. */
export function summary(report: { queued: number; runs: readonly RunReport[]; risks?: RiskReport; memories?: ValidityReport }, budget = RISK_BUDGET, memBudget = VALIDITY_BUDGET): string[] {
  const judged = report.runs.reduce((n, r) => n + r.judged, 0);
  const { risks, memories } = report;
  const head = [
    `${report.runs.length} run(s), ${judged} step(s) judged`,
    ...(report.queued ? [`${report.queued} run(s) queued for new sessions`] : []),
    ...(risks ? [`${risks.judged} risk(s) judged`] : []),
    ...(risks?.held ? [`${risks.held} risk judge(s) left to another runner`] : []),
    ...(memories ? [`${memories.judged} read(s) of memories judged`] : []),
    ...(memories?.held ? [`${memories.held} memory left to another runner`] : []),
  ].join('; ');
  return [
    head,
    ...report.runs.filter((r) => r.status !== 'done').map((r) => `run ${r.run} of judge ${r.judge} ${r.status}: ${r.error}`),
    ...(risks?.stopped ? [`risk judgments stopped before going over their budget of ${budget} input tokens`] : []),
    ...missedLine('risk judgment', risks?.missed),
    ...(risks?.failed ?? []).map((f) => `risk judge of rule ${f.rule} failed: ${f.error}`),
    ...(memories?.stopped ? [`memory validity stopped before going over its budget of ${memBudget} input tokens`] : []),
    ...missedLine('memory validity', memories?.missed),
    ...(memories?.unanswered ? [`${memories.unanswered.calls} read(s) of memories the model answered without a judgment, stored as such: ${memories.unanswered.reason}`] : []),
    ...(memories?.failed ?? []).map((f) => `validity of memory ${f.memory} failed: ${f.error}`),
  ];
}

if (import.meta.main) {
  const db = process.env.DORIS_DB ?? 'otel';
  let close = async () => {};
  try {
    const doris = new Doris(configFromEnv());
    const pool = metaPoolFromEnv();
    close = async () => {
      await doris.close();
      await pool.end();
    };
    const budget = riskBudget(process.env);
    const memBudget = memoryBudget(process.env);
    const judgeModel = judgeModelOf(process.env);
    await migrate(pool);
    const cfg = streamLoadConfigFromEnv();
    const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
    const models = modelsFromEnv(process.env);
    const report = await runJudges({ doris, db, load, store: new JudgeStore(pool), model: models.judge, runner: `${hostname()}-${process.pid}` });
    const risks = await judgeRisks({ doris, db, load, model: models.judge, leases: new Leases(pool), budget, judgeModel });
    const memories = await judgeMemories({ doris, db, load, model: models.fold, leases: new Leases(pool), budget: memBudget, judgeModel });
    const [head, ...problems] = summary({ ...report, risks, memories }, budget, memBudget);
    console.log(head);
    for (const p of problems) console.error(p);
    if (report.runs.some((r) => r.status === 'failed') || risks.failed.length || memories.failed.length) process.exitCode = 1;
  } catch (e) {
    console.error(`run-judges failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
