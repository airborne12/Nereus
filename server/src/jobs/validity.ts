// The memory validity job (spec 6.5): for each memory with reads still to judge, under a lease, it
// asks the fold model about each read in turn, oldest first, from the state the read before left,
// and stores each update as a new version of the memory's state. One budget of input tokens covers
// the pass.

import type { Doris } from '../db/doris.ts';
import { labelFor, type Load } from '../semantics/ingest/writer.ts';
import type { FoldAnswer, FoldMissed, FoldModel } from '../semantics/judges/fold-model.ts';
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
/** A session quiet this long is taken to have finished its last turn. */
const QUIET_MS = 10 * 60_000;

/** `judgeModel` is the model the fold uses instead of the one it has in code. */
export interface ValidityDeps { doris: Doris; db: string; load: Load; model: FoldModel; leases: LeaseStore; budget?: number; now?: () => Date; judgeModel?: string }
/** A memory whose judging failed, by its agent, scope and name, and why. */
export interface ValidityFailed { memory: string; error: string }
/** What a pass did; `missed` calls did not reach the model and are tried again, `unanswered` ones reached it, gave no judgment and are stored as such. */
export interface ValidityReport { judged: number; stopped: boolean; held: number; failed: ValidityFailed[]; missed: Missed | null; unanswered: Missed | null }
/** A memory with its reads still to judge, oldest first. */
interface Due { subject: string; key: string; memory: { name: string; description: string | null; content: string }; reads: ReadRef[] }
interface Done { judged: number; spent: number; missed: Missed | null; unanswered: Missed | null; stopped: boolean }

const EMPTY: ValidityReport = { judged: 0, stopped: false, held: 0, failed: [], missed: null, unanswered: null };
const addCalls = (a: Missed | null, b: Missed | null): Missed | null => (a && b ? { calls: a.calls + b.calls, reason: a.reason } : a ?? b);
const readKey = (sessionId: unknown, seq: unknown): string => `${String(sessionId)}:${Number(seq)}`;
const modelOf = (deps: ValidityDeps): string => deps.judgeModel ?? VALIDITY.model;

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

/** The fold of a memory so far, from its updates newest first: the last version, the latest state with why, and the reads judged. */
function soFar(rows: readonly Record<string, unknown>[]): { version: number; prior: Prior | null; judged: Set<string> } {
  const last = rows.find((r) => r.state !== null && r.state !== undefined);
  return {
    version: rows.length ? Number(rows[0]!.version) : 0,
    prior: last ? { state: String(last.state), reason: String(last.reason ?? '') } : null,
    judged: new Set(rows.map((r) => readKey(r.session_id, r.seq))),
  };
}

async function publish(deps: ValidityDeps): Promise<void> {
  const row = { judge: VALIDITY.judge, version: VALIDITY.version, name: VALIDITY.name, form: 'fold', pick: { subject: 'memory' }, reads: { kind: 'memory-read' }, criterion: VALIDITY.criterion, model: modelOf(deps), created_at: VALIDITY.createdAt, created_by: 'nereus' };
  await deps.load('agent_judges', labelFor('agent_judges', VALIDITY.judge, 0, [row]), [row]);
}

/** Stores one update: the model's evidence and state, or, for an answer that was not an update, no judgment and why. */
async function store(deps: ValidityDeps, due: Due, read: ReadRef, x: { inputSeqs: number[]; hash: string }, answer: FoldAnswer | FoldMissed, version: number, run: string): Promise<void> {
  const update = 'missed' in answer ? { verdict: 'unsure', state: null, evidence: null, reason: answer.missed } : { verdict: null, state: answer.state, evidence: answer.evidence, reason: answer.reason };
  const row = {
    judge: VALIDITY.judge, subject: due.subject, judge_version: VALIDITY.version, version: version + 1, session_id: read.session_id, seq: read.seq,
    verdict: update.verdict, state: update.state, evidence: update.evidence, prev_version: version || null, reason: update.reason,
    input_seqs: x.inputSeqs, input_hash: x.hash, model: modelOf(deps), input_tokens: answer.inputTokens, output_tokens: answer.outputTokens,
    judged_at: dorisTime((deps.now ?? (() => new Date()))().toISOString()),
  };
  await deps.load('agent_judgments', labelFor('agent_judgments', due.subject, version + 1, [row], run), [row]);
}

/**
 * Judges the reads of one memory in turn, leaving out those another runner judged since the list was
 * read. A call that did not reach the model ends it, since the next read starts from its state.
 */
async function judgeOne(deps: ValidityDeps, due: Due, left: number, run: string): Promise<Done> {
  const fold = soFar(await deps.doris.query(priorSql(deps.db, due.subject).sql));
  const reads = due.reads.filter((r) => !fold.judged.has(readKey(r.session_id, r.seq)));
  let done: Done = { judged: 0, spent: 0, missed: null, unanswered: null, stopped: false };
  if (!reads.length) return done;
  const rows = await deps.doris.query(validityReadsSql(deps.db, reads).sql);
  let { prior, version } = fold;
  for (const read of reads) {
    const x = foldText(rows, read, due.memory, prior);
    if (!x) continue;
    const text = `${x.text}\n\n${VALIDITY.criterion}`;
    if (done.spent + Math.ceil((FOLD_SYSTEM.length + text.length) / 4) > left) return { ...done, stopped: true };
    const answer = await deps.model.fold(modelOf(deps), FOLD_SYSTEM, text);
    done = { ...done, spent: done.spent + answer.inputTokens };
    if ('missed' in answer && answer.inputTokens === 0) return { ...done, missed: { calls: 1, reason: answer.missed } };
    await store(deps, due, read, x, answer, version, run);
    version += 1;
    if ('missed' in answer) done = { ...done, unanswered: addCalls(done.unanswered, { calls: 1, reason: answer.missed }) };
    else {
      prior = { state: answer.state, reason: answer.reason };
      done = { ...done, judged: done.judged + 1 };
    }
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
  const now = (deps.now ?? (() => new Date()))();
  const run = dorisTime(now.toISOString()).replace(/\D/g, '');
  const settled = dorisTime(new Date(now.getTime() - QUIET_MS).toISOString());
  const due = dueOf(await deps.doris.query(dueReadsSql(deps.db, settled).sql));
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
      report = { ...report, judged: report.judged + done.judged, missed: addCalls(report.missed, done.missed), unanswered: addCalls(report.unanswered, done.unanswered) };
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
