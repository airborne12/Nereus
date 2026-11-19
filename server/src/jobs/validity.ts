// The memory validity job (spec 6.5): for each memory with reads still to judge, under a lease, it
// asks the fold model about each read in turn, oldest first, from the state the read before left,
// and stores each update as a new version of the memory's state. One budget of input tokens covers
// the pass.

import type { Doris } from '../db/doris.ts';
import { labelFor, type Load } from '../semantics/ingest/writer.ts';
import type { FoldModel } from '../semantics/judges/fold-model.ts';
import { ModelAccessError } from '../semantics/judges/model.ts';
import { dorisTime } from '../semantics/trajectory/model.ts';
import { dueReadsSql, FOLD_SYSTEM, foldText, type Prior, priorSql, type ReadRef, VALIDITY, validityReadsSql } from '../semantics/memories/validity.ts';
import type { LeaseStore } from './leases.ts';
import type { Missed } from './risk-judgments.ts';

export const VALIDITY_JOB = 'memory-validity';
/** How long a runner may hold a memory between two calls before another may take it. */
const LEASE_SECONDS = 300;
/** Input tokens one pass may spend when no budget is given. */
export const VALIDITY_BUDGET = 100_000;

export interface ValidityDeps { doris: Doris; db: string; load: Load; model: FoldModel; leases: LeaseStore; budget?: number; now?: () => Date }
/** A memory whose judging failed, by its agent, scope and name, and why. */
export interface ValidityFailed { memory: string; error: string }
export interface ValidityReport { judged: number; stopped: boolean; held: number; failed: ValidityFailed[]; missed: Missed | null }
/** A memory with its reads still to judge, oldest first. */
interface Due { subject: string; key: string; memory: { name: string; description: string | null; content: string }; reads: ReadRef[] }

const EMPTY: ValidityReport = { judged: 0, stopped: false, held: 0, failed: [], missed: null };

function dueOf(rows: readonly Record<string, unknown>[]): Due[] {
  return rows.reduce<Due[]>((all, r) => {
    const read = { session_id: String(r.session_id), seq: Number(r.seq) };
    const last = all.at(-1);
    if (last && last.subject === String(r.subject)) return [...all.slice(0, -1), { ...last, reads: [...last.reads, read] }];
    return [...all, {
      subject: String(r.subject), key: `${String(r.agent)}/${String(r.scope)}/${String(r.name)}`,
      memory: { name: String(r.name), description: r.description === null || r.description === undefined ? null : String(r.description), content: String(r.content ?? '') }, reads: [read],
    }];
  }, []);
}

async function publish(deps: ValidityDeps): Promise<void> {
  const row = { judge: VALIDITY.judge, version: VALIDITY.version, name: VALIDITY.name, form: 'fold', pick: { subject: 'memory' }, reads: { kind: 'memory-read' }, criterion: VALIDITY.criterion, model: VALIDITY.model, created_at: VALIDITY.createdAt, created_by: 'nereus' };
  await deps.load('agent_judges', labelFor('agent_judges', VALIDITY.judge, 0, [row]), [row]);
}

interface Done { judged: number; spent: number; missed: Missed | null; stopped: boolean }

/** Judges the reads of one memory in turn; a call that gives no update ends it, since the next read starts from its state. */
async function judgeOne(deps: ValidityDeps, due: Due, left: number, run: string): Promise<Done> {
  const [last] = await deps.doris.query(priorSql(deps.db, due.subject).sql);
  let prior: Prior | null = last ? { state: String(last.state), reason: String(last.reason ?? '') } : null;
  let version = last ? Number(last.version) : 0;
  const rows = await deps.doris.query(validityReadsSql(deps.db, due.reads).sql);
  let done: Done = { judged: 0, spent: 0, missed: null, stopped: false };
  for (const read of due.reads) {
    const x = foldText(rows, read, due.memory, prior);
    if (!x) continue;
    const text = `${x.text}\n\n${VALIDITY.criterion}`;
    if (done.spent + Math.ceil((FOLD_SYSTEM.length + text.length) / 4) > left) return { ...done, stopped: true };
    const answer = await deps.model.fold(VALIDITY.model, FOLD_SYSTEM, text);
    done = { ...done, spent: done.spent + answer.inputTokens };
    if ('missed' in answer) return { ...done, missed: { calls: 1, reason: answer.missed } };
    const row = {
      judge: VALIDITY.judge, subject: due.subject, judge_version: VALIDITY.version, version: version + 1, session_id: read.session_id, seq: read.seq,
      verdict: null, state: answer.state, evidence: answer.evidence, prev_version: version || null, reason: answer.reason,
      input_seqs: x.inputSeqs, input_hash: x.hash, model: VALIDITY.model, input_tokens: answer.inputTokens, output_tokens: answer.outputTokens,
      judged_at: dorisTime((deps.now ?? (() => new Date()))().toISOString()),
    };
    await deps.load('agent_judgments', labelFor('agent_judgments', due.subject, version + 1, [row], run), [row]);
    prior = { state: answer.state, reason: answer.reason };
    version += 1;
    done = { ...done, judged: done.judged + 1 };
    if (!(await deps.leases.take(VALIDITY_JOB, due.subject, LEASE_SECONDS))) return done;
  }
  return done;
}

/**
 * One pass over the memories with reads to judge. A memory another runner holds is left to it; a
 * memory that fails is named and the pass goes on, except when the model cannot be used, which
 * ends the pass. A budget of 0 does nothing.
 */
export async function judgeMemories(deps: ValidityDeps): Promise<ValidityReport> {
  const budget = deps.budget ?? VALIDITY_BUDGET;
  if (budget <= 0) return EMPTY;
  const run = dorisTime((deps.now ?? (() => new Date()))().toISOString()).replace(/\D/g, '');
  const due = dueOf(await deps.doris.query(dueReadsSql(deps.db).sql));
  if (due.length) await publish(deps);
  let report = EMPTY;
  let spent = 0;
  for (const d of due) {
    if (!(await deps.leases.take(VALIDITY_JOB, d.subject, LEASE_SECONDS))) {
      report = { ...report, held: report.held + 1 };
      continue;
    }
    try {
      const done = await judgeOne(deps, d, budget - spent, run);
      spent += done.spent;
      const missed = report.missed && done.missed ? { calls: report.missed.calls + done.missed.calls, reason: report.missed.reason } : report.missed ?? done.missed;
      report = { ...report, judged: report.judged + done.judged, missed };
      if (done.stopped) return { ...report, stopped: true };
    } catch (e) {
      report = { ...report, failed: [...report.failed, { memory: d.key, error: (e as Error).message }] };
      if (e instanceof ModelAccessError) return report;
    } finally {
      await deps.leases.release(VALIDITY_JOB, d.subject);
    }
  }
  return report;
}
