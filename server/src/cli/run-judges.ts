// Runs the judges: queues a run for each judge that follows new sessions and has new steps, takes
// queued runs until none is left, then judges the safety risks the rules' judges have not judged.
// Verdicts go to agent_judgments; runs and leases are kept in the metadata database
// (META_DATABASE_URL).
//
//   node src/cli/run-judges.ts
//
// The model is reached through the Anthropic SDK, which takes its key from the environment
// (ANTHROPIC_API_KEY). RISK_JUDGE_BUDGET caps the input tokens of the risk pass; 0 skips it.
// A run or a risk judge that fails is named and the command exits with 1.

import { hostname } from 'node:os';
import { JudgeStore } from '../control/judges/store.ts';
import { Doris, configFromEnv } from '../db/doris.ts';
import { metaPoolFromEnv, migrate } from '../db/meta.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { type RunReport, runJudges } from '../jobs/judges.ts';
import { Leases } from '../jobs/leases.ts';
import { judgeRisks, RISK_BUDGET, type RiskReport } from '../jobs/risk-judgments.ts';
import { claudeClient, claudeJudge } from '../semantics/judges/model.ts';

/** The input tokens the risk pass may spend, from RISK_JUDGE_BUDGET. */
export function riskBudget(env: Record<string, string | undefined>): number {
  const raw = env.RISK_JUDGE_BUDGET;
  if (raw === undefined) return RISK_BUDGET;
  if (!/^\d{1,12}$/.test(raw)) throw new Error('RISK_JUDGE_BUDGET must be a whole number of input tokens');
  return Number(raw);
}

/** What the command prints: one line, then one line per run that did not finish, a stop of the risk pass, its calls that did not reach the model, and each risk judge that failed. */
export function summary(report: { queued: number; runs: readonly RunReport[]; risks?: RiskReport }, budget = RISK_BUDGET): string[] {
  const judged = report.runs.reduce((n, r) => n + r.judged, 0);
  const { risks } = report;
  const head = [
    `${report.runs.length} run(s), ${judged} step(s) judged`,
    ...(report.queued ? [`${report.queued} run(s) queued for new sessions`] : []),
    ...(risks ? [`${risks.judged} risk(s) judged`] : []),
    ...(risks?.held ? [`${risks.held} risk judge(s) left to another runner`] : []),
  ].join('; ');
  return [
    head,
    ...report.runs.filter((r) => r.status !== 'done').map((r) => `run ${r.run} of judge ${r.judge} ${r.status}: ${r.error}`),
    ...(risks?.stopped ? [`risk judgments stopped before going over their budget of ${budget} input tokens`] : []),
    ...(risks?.missed ? [`${risks.missed.calls} risk judgment call(s) did not reach the model and will be tried again on the next pass: ${risks.missed.reason}`] : []),
    ...(risks?.failed ?? []).map((f) => `risk judge of rule ${f.rule} failed: ${f.error}`),
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
    await migrate(pool);
    const cfg = streamLoadConfigFromEnv();
    const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
    const model = claudeJudge(claudeClient());
    const report = await runJudges({ doris, db, load, store: new JudgeStore(pool), model, runner: `${hostname()}-${process.pid}` });
    const risks = await judgeRisks({ doris, db, load, model, leases: new Leases(pool), budget });
    const [head, ...problems] = summary({ ...report, risks }, budget);
    console.log(head);
    for (const p of problems) console.error(p);
    if (report.runs.some((r) => r.status === 'failed') || risks.failed.length) process.exitCode = 1;
  } catch (e) {
    console.error(`run-judges failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
