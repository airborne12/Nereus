// The judge runner (spec 8.7, stages 2 and 3): reads what the model sees for each step with one
// statement, then asks the model a few steps at a time and makes the rows of agent_judgments.

import type { Doris } from '../../db/doris.ts';
import { dorisTime } from '../trajectory/model.ts';
import type { JudgeVersion, Verdict } from './judge.ts';
import type { JudgeModel } from './model.ts';
import { type Excerpt, excerptsOf } from './prompt.ts';
import { readsSql, type StepRef } from './statements.ts';

/** Model calls a runner makes at once. */
export const CONCURRENCY = 4;

/** A row of `agent_judgments` made by a map judge. */
export interface JudgmentRow {
  judge: string; subject: string; judge_version: number; version: 1;
  session_id: string; seq: number; verdict: Verdict; state: null; evidence: null; prev_version: null;
  reason: string; input_seqs: number[]; input_hash: string; model: string; input_tokens: number; output_tokens: number; judged_at: string;
}

/** What the model reads for each step, in the order given; a step that no longer exists has nothing. */
export async function readSteps(deps: { doris: Doris; db: string }, v: Pick<JudgeVersion, 'reads'>, steps: readonly StepRef[]): Promise<Excerpt[]> {
  if (!steps.length) return [];
  return excerptsOf(await deps.doris.query(readsSql(deps.db, v.reads, steps).sql), steps);
}

/** Judges each excerpt with the version's criterion and model; a model that cannot be used stops it. */
export async function judgeExcerpts(deps: { model: JudgeModel; concurrency?: number; now?: () => Date }, v: JudgeVersion, excerpts: readonly Excerpt[]): Promise<JudgmentRow[]> {
  const size = deps.concurrency ?? CONCURRENCY;
  const chunks = Array.from({ length: Math.ceil(excerpts.length / size) }, (_, i) => excerpts.slice(i * size, (i + 1) * size));
  let rows: JudgmentRow[] = [];
  for (const chunk of chunks) {
    const answers = await Promise.all(chunk.map((x) => deps.model.judge(v.model, v.criterion, x.text)));
    const at = dorisTime((deps.now ?? (() => new Date()))().toISOString());
    rows = [...rows, ...chunk.map((x, i): JudgmentRow => ({
      judge: v.judge, subject: x.subject, judge_version: v.version, version: 1, session_id: x.session_id, seq: x.seq,
      verdict: answers[i]!.verdict, state: null, evidence: null, prev_version: null, reason: answers[i]!.reason,
      input_seqs: x.inputSeqs, input_hash: x.hash, model: v.model, input_tokens: answers[i]!.inputTokens, output_tokens: answers[i]!.outputTokens, judged_at: at,
    }))];
  }
  return rows;
}
