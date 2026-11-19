// The judge job (spec 6.5): takes queued runs from PostgreSQL and judges their steps. A run writes
// the judge's versions to agent_judges, chooses its steps in Doris, then reads, judges and stores
// them a batch at a time, within its budget of input tokens.

import type { JudgeStore, RunRecord } from '../control/judges/store.ts';
import type { Doris } from '../db/doris.ts';
import { labelFor, type Load } from '../semantics/ingest/writer.ts';
import type { JudgeVersion } from '../semantics/judges/judge.ts';
import type { JudgeModel } from '../semantics/judges/model.ts';
import { estimateTokens } from '../semantics/judges/prompt.ts';
import { judgeExcerpts, readSteps } from '../semantics/judges/runner.ts';
import { type StepRef, subjectsSql } from '../semantics/judges/statements.ts';

/** Steps read and judged together. */
export const BATCH = 20;
/** Who queues the runs of judges that follow new sessions. */
const NEW_SESSIONS = 'new sessions';

/** The part of the judge store the job uses. */
export type JudgeQueue = Pick<JudgeStore, 'versions' | 'started' | 'progress' | 'finish' | 'judges' | 'hasOpenRun' | 'enqueue' | 'claim'>;
export interface JudgeJobDeps { doris: Doris; db: string; load: Load; store: JudgeQueue; model: JudgeModel; runner: string; batch?: number; concurrency?: number; now?: () => Date }
export interface RunReport { run: number; judge: string; status: 'done' | 'stopped' | 'failed'; judged: number; error: string | null }

/** Writes every version of a judge to agent_judges; writing one again changes nothing. */
async function publish(deps: JudgeJobDeps, versions: readonly JudgeVersion[]): Promise<void> {
  const rows = versions.map((v) => ({ judge: v.judge, version: v.version, name: v.name, form: 'map', pick: v.pick, reads: v.reads, criterion: v.criterion, model: v.model, created_at: v.createdAt, created_by: v.createdBy }));
  if (rows.length) await deps.load('agent_judges', labelFor('agent_judges', versions[0]!.judge, 0, rows), rows);
}

const chunks = <T>(xs: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** Judges the steps of one run; the run's row says how it ended. */
export async function runOne(deps: JudgeJobDeps, run: RunRecord): Promise<RunReport> {
  let judged = run.judged;
  const end = async (status: RunReport['status'], error: string | null): Promise<RunReport> => {
    await deps.store.finish(run.id, status, error);
    return { run: run.id, judge: run.judge, status, judged, error };
  };
  try {
    const versions = await deps.store.versions(run.judge);
    const v = versions.find((x) => x.version === run.version);
    if (!v) return await end('failed', `version ${run.version} of judge ${run.judge} does not exist`);
    await publish(deps, versions);
    const steps: StepRef[] = (await deps.doris.query(subjectsSql(deps.db, v, run.scope).sql)).map((r) => ({ session_id: String(r.session_id), seq: Number(r.seq) }));
    const total = run.judged + steps.length;
    await deps.store.started(run.id, total);
    let tokensIn = run.inputTokens;
    let tokensOut = run.outputTokens;
    for (const [i, part] of chunks(steps, deps.batch ?? BATCH).entries()) {
      const excerpts = await readSteps(deps, v, part);
      const estimate = excerpts.reduce((n, x) => n + estimateTokens(v.criterion, x.text), 0);
      if (tokensIn + estimate > run.budget) return await end('stopped', `Stopped before going over the budget of ${run.budget} input tokens: ${judged} of ${total} steps judged.`);
      const rows = await judgeExcerpts(deps, v, excerpts);
      if (rows.length) await deps.load('agent_judgments', labelFor('agent_judgments', run.judge, i, rows, `run${run.id}`), rows);
      judged += rows.length;
      tokensIn += rows.reduce((n, r) => n + r.input_tokens, 0);
      tokensOut += rows.reduce((n, r) => n + r.output_tokens, 0);
      await deps.store.progress(run.id, judged, tokensIn, tokensOut);
    }
    return await end('done', null);
  } catch (e) {
    return end('failed', (e as Error).message);
  }
}

/** Queues a run for each judge that follows new sessions, has new steps and no open run; answers how many. */
export async function queueNewSessions(deps: Pick<JudgeJobDeps, 'doris' | 'db' | 'store'>): Promise<number> {
  let queued = 0;
  for (const j of (await deps.store.judges()).filter((x) => x.runsOnNew)) {
    if (await deps.store.hasOpenRun(j.id)) continue;
    const v = (await deps.store.versions(j.id)).find((x) => x.version === j.currentVersion);
    if (!v || !(await deps.doris.query(`${subjectsSql(deps.db, v, 'new').sql}\nLIMIT 1`)).length) continue;
    await deps.store.enqueue(j.id, 'new', NEW_SESSIONS);
    queued += 1;
  }
  return queued;
}

/** Queues the runs of new sessions, then takes runs until none is left. */
export async function runJudges(deps: JudgeJobDeps): Promise<{ queued: number; runs: RunReport[] }> {
  const queued = await queueNewSessions(deps);
  let runs: RunReport[] = [];
  for (let run = await deps.store.claim(deps.runner); run; run = await deps.store.claim(deps.runner)) runs = [...runs, await runOne(deps, run)];
  return { queued, runs };
}
