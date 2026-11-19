// The judge job (spec 6.5): takes queued runs from PostgreSQL and judges their steps. A run writes
// the judge's versions to agent_judges, chooses its steps in Doris, then reads a batch of them and
// judges and stores it a chunk at a time, within its budget of input tokens. Only the runner that
// holds a run writes to it; one that finds the run taken by another stops.

import { AuthError } from '../control/auth/store.ts';
import type { JudgeStore, RunRecord } from '../control/judges/store.ts';
import type { Doris } from '../db/doris.ts';
import { labelFor, type Load } from '../semantics/ingest/writer.ts';
import type { JudgeVersion } from '../semantics/judges/judge.ts';
import type { JudgeModel } from '../semantics/judges/model.ts';
import { judgeExcerpts, readSteps } from '../semantics/judges/runner.ts';
import { type StepRef, subjectsSql } from '../semantics/judges/statements.ts';

/** Steps read together; they are judged a few at a time. */
export const BATCH = 20;
/** Who queues the runs of judges that follow new sessions. */
const NEW_SESSIONS = 'new sessions';
const LOST = 'Another runner took this run over.';

/** The part of the judge store the job uses. */
export type JudgeQueue = Pick<JudgeStore, 'versions' | 'started' | 'progress' | 'finish' | 'judges' | 'hasOpenRun' | 'enqueue' | 'claim'>;
export interface JudgeJobDeps { doris: Doris; db: string; load: Load; store: JudgeQueue; model: JudgeModel; runner: string; batch?: number; concurrency?: number; now?: () => Date }
/** How a run ended; `lost` when another runner took it, which then writes its end. */
export interface RunReport { run: number; judge: string; status: 'done' | 'stopped' | 'failed' | 'lost'; judged: number; error: string | null }

class LostRun extends Error {}

/** Writes every version of a judge to agent_judges; writing one again changes nothing. */
async function publish(deps: JudgeJobDeps, versions: readonly JudgeVersion[]): Promise<void> {
  const rows = versions.map((v) => ({ judge: v.judge, version: v.version, name: v.name, form: 'map', pick: v.pick, reads: v.reads, criterion: v.criterion, model: v.model, created_at: v.createdAt, created_by: v.createdBy }));
  if (rows.length) await deps.load('agent_judges', labelFor('agent_judges', versions[0]!.judge, 0, rows), rows);
}

const chunks = <T>(xs: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** Judges the steps of one run; the run's row says how it ended. */
export async function runOne(deps: JudgeJobDeps, run: RunRecord): Promise<RunReport> {
  let judged = run.judged;
  const hold = async (written: Promise<boolean>) => {
    if (!(await written)) throw new LostRun(LOST);
  };
  const end = async (status: 'done' | 'stopped' | 'failed', error: string | null): Promise<RunReport> => {
    await hold(deps.store.finish(run.id, deps.runner, status, error));
    return { run: run.id, judge: run.judge, status, judged, error };
  };
  const lost = (): RunReport => ({ run: run.id, judge: run.judge, status: 'lost', judged, error: LOST });
  try {
    const versions = await deps.store.versions(run.judge);
    const v = versions.find((x) => x.version === run.version);
    if (!v) return await end('failed', `version ${run.version} of judge ${run.judge} does not exist`);
    await publish(deps, versions);
    const steps: StepRef[] = (await deps.doris.query(subjectsSql(deps.db, v, run.scope).sql)).map((r) => ({ session_id: String(r.session_id), seq: Number(r.seq) }));
    const total = run.judged + steps.length;
    await hold(deps.store.started(run.id, deps.runner, total));
    let tokensIn = run.inputTokens;
    let tokensOut = run.outputTokens;
    for (const [i, part] of chunks(steps, deps.batch ?? BATCH).entries()) {
      let n = 0;
      const { stopped } = await judgeExcerpts(deps, v, await readSteps(deps, v, part), {
        budget: run.budget - tokensIn,
        ...(judged ? { perCall: tokensIn / judged } : {}),
        onChunk: async (rows) => {
          await deps.load('agent_judgments', labelFor('agent_judgments', run.judge, i * 100 + n, rows, `run${run.id}`), rows);
          n += 1;
          judged += rows.length;
          tokensIn += rows.reduce((t, r) => t + r.input_tokens, 0);
          tokensOut += rows.reduce((t, r) => t + r.output_tokens, 0);
          await hold(deps.store.progress(run.id, deps.runner, judged, tokensIn, tokensOut));
        },
      });
      if (stopped) return await end('stopped', `Stopped before going over the budget of ${run.budget} input tokens: ${judged} of ${total} steps judged.`);
    }
    return await end('done', null);
  } catch (e) {
    if (e instanceof LostRun) return lost();
    try {
      return await end('failed', (e as Error).message);
    } catch (again) {
      if (again instanceof LostRun) return lost();
      throw again;
    }
  }
}

/** Queues a run, with the judge's budget, for each judge that follows new sessions, has new steps and no open run; answers how many. */
export async function queueNewSessions(deps: Pick<JudgeJobDeps, 'doris' | 'db' | 'store'>): Promise<number> {
  let queued = 0;
  for (const j of (await deps.store.judges()).filter((x) => x.runsOnNew)) {
    if (await deps.store.hasOpenRun(j.id)) continue;
    const v = (await deps.store.versions(j.id)).find((x) => x.version === j.currentVersion);
    if (!v || !(await deps.doris.query(`${subjectsSql(deps.db, v, 'new').sql}\nLIMIT 1`)).length) continue;
    try {
      await deps.store.enqueue(j.id, 'new', NEW_SESSIONS, j.budget);
      queued += 1;
    } catch (e) {
      // Another runner queued one in the meantime.
      if (!(e instanceof AuthError && e.status === 409)) throw e;
    }
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
