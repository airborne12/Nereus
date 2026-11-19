// The sequences API: what happens after a kind of event, the tools of a range, and the places
// where the steps of a pattern follow one another.

import type { Statement } from './agents.ts';
import { get, send } from './http.ts';
import type { Step, StepKind } from '../lib/agents/sequences.ts';

/** The branches of a node that are not drawn on their own. */
export interface Other { count: number; times: number }
/** An event after the start: `c:<tool>`, `f:<tool>` (failed), `u:`, `r:`, `x:`, or empty for "the session ends". */
export interface PathNode { key: string; times: number; kids: PathNode[]; other: Other | null }
export interface PathTree { total: number; kids: PathNode[]; other: Other | null }
export interface NextAnswer extends PathTree { start: string; depth: number; sql: Statement[]; elapsedMs: number }

export interface Tool { name: string; calls: number }
export interface ToolsAnswer { tools: Tool[]; sql: Statement[]; elapsedMs: number }

/** One event of a match. `call` is the model call that issued a tool call. */
export interface MatchStep { kind: StepKind; seq: number; call: number | null; ts: string; turn: number; step: number; what: string; status: string; target: string }
export interface Match { session_id: string; root_id: string; title: string | null; agent: string; ts: string; turn: number; span: number; steps: MatchStep[] }
export interface MatchAnswer { rows: Match[]; matches: number; sessions: number; pattern: Step[]; sql: Statement[]; elapsedMs: number }

export interface MatchQuery { from: number; to: number; pattern: Step[]; sort: string; dir: 'asc' | 'desc'; limit: number; offset: number }

const iso = (ms: number): string => new Date(ms).toISOString();

export function next(range: { from: number; to: number }, start: string, signal?: AbortSignal): Promise<NextAnswer> {
  return get<NextAnswer>('/api/agents/sequences/next', { from: iso(range.from), to: iso(range.to), start }, signal);
}

export function tools(range: { from: number; to: number }, signal?: AbortSignal): Promise<ToolsAnswer> {
  return get<ToolsAnswer>('/api/agents/sequences/tools', { from: iso(range.from), to: iso(range.to) }, signal);
}

export function match(q: MatchQuery, signal?: AbortSignal): Promise<MatchAnswer> {
  return send<MatchAnswer>('POST', '/api/agents/sequences/match', { ...q, from: iso(q.from), to: iso(q.to) }, signal);
}
