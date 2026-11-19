// The agent trajectory API: the table pages and their exports, the session page with its risks, and Compare.
// Rows keep the database column names; big integers arrive as text, so readers convert with Number().

import { ensureOk, getQuery } from './http.ts';

export type Row = Record<string, unknown>;
/** One statement that ran, as the SQL dialog shows it. */
export interface Statement { title: string; sql: string }
export interface ColumnInfo { name: string; kind: 'text' | 'number' | 'time' }
export type TableName = 'sessions' | 'steps' | 'messages' | 'risks';
export type ExportFormat = 'csv' | 'jsonl';

/** What a table page asks for: a time range in epoch ms, search text, conditions `column:op:value`, sort and paging. */
export interface TableQuery {
  from: number;
  to: number;
  q: string;
  conditions: string[];
  sort: string;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface TableAnswer { rows: Row[]; total: number; columns: ColumnInfo[]; sql: Statement[]; elapsedMs: number }

/** The filter of a table request: range, search, conditions and sort, without paging. */
export function filterParams(q: TableQuery): URLSearchParams {
  const p = new URLSearchParams({ from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString() });
  if (q.q.trim()) p.set('q', q.q.trim());
  for (const c of q.conditions) p.append('f', c);
  p.set('sort', q.sort);
  p.set('dir', q.dir);
  return p;
}

export function table(page: TableName, q: TableQuery, signal?: AbortSignal): Promise<TableAnswer> {
  const p = filterParams(q);
  p.set('limit', String(q.limit));
  p.set('offset', String(q.offset));
  return getQuery<TableAnswer>(`/api/agents/${page}`, p, signal);
}

/** What the export dialog shows before the file is read: counts, a preview and the statements. */
export interface ExportSize {
  /** CSV: `rows` and `bytes`. Conversations: `sessions`, `parts`, `blocks` and `bytes`. */
  size: Record<string, unknown>;
  /** CSV: the first lines as text. Conversations: the first lines as objects. */
  preview: string | Row[];
  sql: Statement[];
  elapsedMs: number;
}

function exportParams(q: TableQuery, format: ExportFormat): URLSearchParams {
  const p = filterParams(q);
  p.set('format', format);
  return p;
}

export function exportSize(page: TableName, q: TableQuery, format: ExportFormat, signal?: AbortSignal): Promise<ExportSize> {
  const p = exportParams(q, format);
  p.set('size', '1');
  return getQuery<ExportSize>(`/api/agents/${page}`, p, signal);
}

/** Reads an export as a file with the name the server gave it. An export over its cap is refused with a message. */
export async function exportFile(page: TableName, q: TableQuery, format: ExportFormat, signal?: AbortSignal): Promise<{ blob: Blob; name: string }> {
  const res = await ensureOk(await fetch(`/api/agents/${page}?${exportParams(q, format)}`, { signal }));
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `agent-${page}.${format}`;
  return { blob: await res.blob(), name };
}

const none = () => new URLSearchParams();
const sessionPath = (id: string) => `/api/agents/sessions/${encodeURIComponent(id)}`;

/** One event of a risk. `call` is the model call that issued a tool call. */
export interface RiskStep { kind: 'call' | 'user' | 'reply' | 'compaction'; seq: number; call: number | null; turn: number; step: number; what: string; status: string; target: string }
/** A place where a session broke a safety rule. */
export interface Risk {
  session_id: string; rule: string; rule_name: string; first_seq: number; rule_version: number; ts: string; turn: number;
  events: number[]; steps: RiskStep[]; what: string; why: string; found_at: string;
}
/** A step of a safety rule: `words` are whole words of a command, `any` texts anywhere in a target. */
export interface RuleStep { kind: RiskStep['kind']; tool?: string; status?: 'ok' | 'failed'; has?: string; any?: string[]; words?: string[]; link?: 'next' | 'later' }
/** A safety rule: a command that needs a confirmation, an order that is not allowed, or a command that never is. */
export interface RuleInfo { id: string; version: number; kind: 'confirm' | 'forbid' | 'deny'; name: string; source: string; steps: RuleStep[]; confirm?: string[]; refuse?: string[] }

export interface TreeAnswer {
  sessions: Row[];
  turns: Row[];
  /** Failed and repeated calls, calls that started a sub-agent, and compactions. */
  marks: Row[];
  /** The tree has more marks than were sent. */
  marksCut: boolean;
  /** The risks the safety rules found in the tree, in the order they happened. */
  risks: Risk[];
  risksCut: boolean;
  /** The rules, sent when the tree has a risk. */
  rules: RuleInfo[];
  /** Every light step row when the tree is small; null otherwise. */
  steps: Row[] | null;
  openAll: boolean;
  sql: Statement[];
  elapsedMs: number;
}
export interface TurnAnswer { blocks: Row[]; sql: Statement[]; elapsedMs: number }
export interface TurnStepsAnswer { steps: Row[]; offset: number; pageSize: number; sql: Statement[]; elapsedMs: number }
export interface StepAnswer {
  step: Row;
  /** Blocks of the request, latest first, one page at a time. */
  input: Row[];
  inputTotal: number;
  inputNew: number;
  output: Row[];
  prompt: Row | null;
  sql: Statement[];
  elapsedMs: number;
}
export interface CompactionAnswer { event: Row; replaced: Row[]; summary: Row[]; sql: Statement[]; elapsedMs: number }

export const tree = (id: string, signal?: AbortSignal) => getQuery<TreeAnswer>(sessionPath(id), none(), signal);
export const turn = (id: string, n: number, signal?: AbortSignal) => getQuery<TurnAnswer>(`${sessionPath(id)}/turns/${n}`, none(), signal);
export const turnSteps = (id: string, n: number, offset: number, signal?: AbortSignal) =>
  getQuery<TurnStepsAnswer>(`${sessionPath(id)}/turns/${n}/steps`, new URLSearchParams({ offset: String(offset) }), signal);
export const step = (id: string, seq: number, inputOffset: number, signal?: AbortSignal) =>
  getQuery<StepAnswer>(`${sessionPath(id)}/steps/${seq}`, new URLSearchParams({ inputOffset: String(inputOffset) }), signal);
export const compaction = (id: string, seq: number, signal?: AbortSignal) =>
  getQuery<CompactionAnswer>(`${sessionPath(id)}/events/${seq}/compaction`, none(), signal);

/** What a step did, as Compare pairs it; `ctx` is the size of its request in tokens. */
export interface StepFacts { seq: number; step: number; tools: string; targets: string; failed: boolean; ctx: number }
/** One row of a pair of turns: an index into each side, or null where that side has no step. */
export interface PairRow { a: number | null; b: number | null; differs: boolean }
/** A compaction of a turn: `after` is the index of the step it follows, -1 before the first. */
export interface CutFacts { seq: number; after: number }
export interface TurnPair { a: StepFacts[]; b: StepFacts[]; rows: PairRow[]; cuts: { a: CutFacts[]; b: CutFacts[] } }
export interface CompareAnswer { sessions: Row[]; turns: Row[]; steps: TurnPair | null; sql: Statement[]; elapsedMs: number }

export function compare(a: string, b: string, turnNo: number | null, signal?: AbortSignal): Promise<CompareAnswer> {
  const p = new URLSearchParams({ a, b });
  if (turnNo !== null) p.set('turn', String(turnNo));
  return getQuery<CompareAnswer>('/api/agents/compare', p, signal);
}
