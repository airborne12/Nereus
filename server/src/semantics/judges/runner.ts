// The judge runner (spec 8.7, stages 2 and 3): reads what the model sees for each step with one
// statement, then asks the model a few steps at a time and makes the rows of agent_judgments.

import type { Doris } from '../../db/doris.ts';
import { dorisTime } from '../trajectory/model.ts';
import type { JudgeVersion, Verdict } from './judge.ts';
import { type JudgeModel, ModelAccessError } from './model.ts';
import { estimateTokens, type Excerpt, excerptsOf } from './prompt.ts';
import { readsSql, type StepRef } from './statements.ts';

/** Model calls a runner makes at once. */
export const CONCURRENCY = 4;

/** A row of `agent_judgments` made by a map judge. */
export interface JudgmentRow {
  judge: string; subject: string; judge_version: number; version: 1;
  session_id: string; seq: number; verdict: Verdict; state: null; evidence: null; prev_version: null;
  reason: string; input_seqs: number[]; input_hash: string; model: string; input_tokens: number; output_tokens: number; judged_at: string;
}

export interface JudgeOptions {
  /** Input tokens the judging may still spend; it stops before a chunk whose estimate would go over. */
  budget?: number;
  /** Input tokens a call has taken on average so far, when known. */
  perCall?: number;
  /** Takes the rows of each chunk as soon as they are made, before the next chunk is judged. */
  onChunk?: (rows: JudgmentRow[]) => Promise<void>;
  /** The system prompt of every call, when not that of the step judges. */
  system?: string;
}

/** What the model reads for each step, in the order given; a step that no longer exists has nothing. */
export async function readSteps(deps: { doris: Doris; db: string }, v: Pick<JudgeVersion, 'reads'>, steps: readonly StepRef[]): Promise<Excerpt[]> {
  if (!steps.length) return [];
  return excerptsOf(await deps.doris.query(readsSql(deps.db, v.reads, steps).sql), steps);
}

/**
 * Judges each excerpt with the version's criterion and model, a few at a time. It stops before a
 * chunk would go over the budget, estimating a chunk from its text or from what calls have really
 * taken, whichever is more. A model that cannot be used, or a chunk in which no call reached the
 * model, stops it with a `ModelAccessError`.
 */
export async function judgeExcerpts(
  deps: { model: JudgeModel; concurrency?: number; now?: () => Date }, v: Pick<JudgeVersion, 'judge' | 'version' | 'criterion' | 'model'>, excerpts: readonly Excerpt[], opts: JudgeOptions = {},
): Promise<{ rows: JudgmentRow[]; stopped: boolean }> {
  const size = deps.concurrency ?? CONCURRENCY;
  const chunks = Array.from({ length: Math.ceil(excerpts.length / size) }, (_, i) => excerpts.slice(i * size, (i + 1) * size));
  let rows: JudgmentRow[] = [];
  let spent = 0;
  for (const chunk of chunks) {
    const average = rows.length ? spent / rows.length : (opts.perCall ?? 0);
    const estimate = Math.max(chunk.reduce((n, x) => n + estimateTokens(v.criterion, x.text, opts.system), 0), Math.ceil(average * chunk.length));
    if (opts.budget !== undefined && spent + estimate > opts.budget) return { rows, stopped: true };
    const answers = await Promise.all(chunk.map((x) => deps.model.judge(v.model, v.criterion, x.text, opts.system)));
    if (answers.every((a) => a.verdict === 'unsure' && a.inputTokens === 0)) throw new ModelAccessError(`No call reached the model: ${answers[0]!.reason}`);
    const at = dorisTime((deps.now ?? (() => new Date()))().toISOString());
    const made = chunk.map((x, i): JudgmentRow => ({
      judge: v.judge, subject: x.subject, judge_version: v.version, version: 1, session_id: x.session_id, seq: x.seq,
      verdict: answers[i]!.verdict, state: null, evidence: null, prev_version: null, reason: answers[i]!.reason,
      input_seqs: x.inputSeqs, input_hash: x.hash, model: v.model, input_tokens: answers[i]!.inputTokens, output_tokens: answers[i]!.outputTokens, judged_at: at,
    }));
    await opts.onChunk?.(made);
    rows = [...rows, ...made];
    spent += made.reduce((n, r) => n + r.input_tokens, 0);
  }
  return { rows, stopped: false };
}
