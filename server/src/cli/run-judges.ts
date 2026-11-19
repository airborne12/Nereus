// Runs the judges: queues a run for each judge that follows new sessions and has new steps, then
// takes queued runs until none is left. Verdicts go to agent_judgments; runs are kept in the
// metadata database (META_DATABASE_URL).
//
//   node src/cli/run-judges.ts
//
// The model is reached through the Anthropic SDK, which takes its key from the environment
// (ANTHROPIC_API_KEY). A run that fails is named and the command exits with 1.

import { hostname } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { JudgeStore } from '../control/judges/store.ts';
import { Doris, configFromEnv } from '../db/doris.ts';
import { metaPoolFromEnv, migrate } from '../db/meta.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { type RunReport, runJudges } from '../jobs/judges.ts';
import { claudeJudge } from '../semantics/judges/model.ts';

/** What the command prints: one line, then one line per run that did not finish. */
export function summary(report: { queued: number; runs: readonly RunReport[] }): string[] {
  const judged = report.runs.reduce((n, r) => n + r.judged, 0);
  const head = `${report.runs.length} run(s), ${judged} step(s) judged${report.queued ? `; ${report.queued} run(s) queued for new sessions` : ''}`;
  return [head, ...report.runs.filter((r) => r.status !== 'done').map((r) => `run ${r.run} of judge ${r.judge} ${r.status}: ${r.error}`)];
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
    await migrate(pool);
    const cfg = streamLoadConfigFromEnv();
    const report = await runJudges({
      doris, db, load: (t, l, r) => streamLoad(cfg, db, t, l, r), store: new JudgeStore(pool), model: claudeJudge(new Anthropic()), runner: `${hostname()}-${process.pid}`,
    });
    const [head, ...problems] = summary(report);
    console.log(head);
    for (const p of problems) console.error(p);
    if (report.runs.some((r) => r.status === 'failed')) process.exitCode = 1;
  } catch (e) {
    console.error(`run-judges failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
