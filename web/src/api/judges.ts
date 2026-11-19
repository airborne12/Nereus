// The judges API: templates to start from, the list, one judge in a view, the verdicts of one
// step, a preview of a draft with a try, and the writes (admins).

import type { Statement } from './agents.ts';
import { get, send } from './http.ts';

export interface Pick { tool: string; has: string; status: 'any' | 'ok' | 'error' }
export type Reads = { kind: 'step' } | { kind: 'before'; n: number } | { kind: 'turn' };
export type Verdict = 'violates' | 'ok' | 'unsure';
export type View = 'first' | 'all' | 'changed';

export interface JudgeTemplate { name: string; pick: Pick; reads: Reads; criterion: string; model: string }
export interface TemplatesAnswer { templates: Record<string, JudgeTemplate>; models: string[]; defaultModel: string }

export interface Run {
  id: number; judge: string; version: number; scope: 'picked' | 'new' | 'stale' | 'stale-violating' | 'failed'; status: 'queued' | 'running' | 'done' | 'stopped' | 'failed';
  budget: number; steps: number | null; judged: number; inputTokens: number; outputTokens: number; error: string | null;
  createdAt: string; createdBy: string; startedAt: string | null; finishedAt: string | null;
}
export interface Version { judge: string; version: number; name: string; pick: Pick; reads: Reads; criterion: string; model: string; createdAt: string; createdBy: string }
export interface Judge { id: string; name: string; currentVersion: number; runsOnNew: boolean; budget: number; createdAt: string; createdBy: string }
/** `failed`: verdicts of the current version that are unsure because the model call failed. */
export interface Counts { judged: number; violations: number; sessions: number; stale: number; staleViolating: number; tokensPerStep: number; failed: number }
/** What a rerun judges: out-of-date verdicts, the violating ones among them, steps a run left, or steps whose model call failed. */
export type Rerun = 'all' | 'violates' | 'unjudged' | 'failed';

export interface JudgeRow extends Judge, Counts { version: number; pick: Pick; pickText: string; reads: Reads; criterion: string; model: string; lastRun: Run | null; lastJudged: string | null }
export interface ListAnswer { rows: JudgeRow[]; sql: Statement[]; elapsedMs: number }

/** A judged step with its latest verdict, as a view lists it. */
export interface VerdictRow {
  ts: string; session_id: string; seq: number; turn: number; step: number; title: string | null; root_id: string | null; calls: string | null;
  verdict: Verdict; made_by: number; stale: number | boolean; reason: string; violations: number | null; was: Verdict | null; was_version: number | null;
}
export interface JudgeAnswer {
  judge: Judge; versions: Version[]; runs: Run[]; pickText: string; readsText: string; counts: Counts; view: View; rows: VerdictRow[]; sql: Statement[]; elapsedMs: number;
}

export interface StepVerdict { judge_version: number; verdict: Verdict; reason: string; model: string; input_seqs: number[]; input_tokens: number; output_tokens: number; judged_at: string }
export interface StepAnswer { verdicts: StepVerdict[]; read: string | null; sql: Statement[]; elapsedMs: number }

export interface Sample { session_id: string; seq: number; ts: string | null; text: string; verdict?: Verdict; reason?: string }
export interface PreviewAnswer { steps: number; sessions: number; estimate: number; sample: Sample[]; sql: Statement[]; elapsedMs: number }

export interface DraftBody { name: string; pick: Pick; reads: Reads; criterion: string; model: string; runsOnNew: boolean }

const at = (id: string) => `/api/agents/judges/${encodeURIComponent(id)}`;

export const templates = (signal?: AbortSignal) => get<TemplatesAnswer>('/api/agents/judges/templates', {}, signal);
export const list = (signal?: AbortSignal) => get<ListAnswer>('/api/agents/judges', {}, signal);
export const judge = (id: string, view: View, signal?: AbortSignal) => get<JudgeAnswer>(at(id), { view }, signal);
export const step = (id: string, session: string, seq: number, signal?: AbortSignal) =>
  get<StepAnswer>(`${at(id)}/steps/${encodeURIComponent(session)}/${seq}`, {}, signal);

export const preview = (body: Omit<DraftBody, 'name' | 'runsOnNew'> & { try?: boolean }, signal?: AbortSignal) =>
  send<PreviewAnswer>('POST', '/api/agents/judges/preview', body, signal);
export const create = (body: DraftBody) => send<{ judge: Judge; run: Run }>('POST', '/api/agents/judges', body);
export const addVersion = (id: string, criterion: string, model: string) => send<{ version: Version }>('POST', `${at(id)}/versions`, { criterion, model });
export const rerun = (id: string, only: Rerun) => send<{ run: Run }>('POST', `${at(id)}/reruns`, { only });
