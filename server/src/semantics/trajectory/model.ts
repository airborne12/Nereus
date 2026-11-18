// The neutral capture records that adapters emit, and the rows of the agent tables that the
// normaliser makes from them (spec sections 5 and 6.1). Record times are ISO 8601 UTC; row times
// are Doris DATETIME(6) strings.

export type Role = 'system' | 'user' | 'assistant' | 'tool';
export type BlockKind = 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'summary' | 'attachment';
export type EventKind = 'user_input' | 'llm_call' | 'tool_call' | 'compaction' | 'error' | 'note';
export type CtxChange = 'fresh' | 'append' | 'truncate' | 'compact';

/** One content block as the source has it; `apiMsg` names the API message it belongs to, unique in the file. */
export interface Block {
  role: Role;
  kind: BlockKind;
  apiMsg: string;
  text: string;
  payload: unknown;
  toolName: string | null;
  toolCallId: string | null;
  isError: boolean | null;
  ts: string;
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * A request's context as the source logs it: the first `keep` API messages of the base request,
 * then `tail`, one entry per API message listing the `apiMsg` keys it is made of. `exact` is false
 * when some tail message could not be found.
 */
export interface ContextDelta { request: string; base: string | null; keep: number; tail: string[][]; exact: boolean }

export interface SessionRecord {
  type: 'session';
  id: string;
  rootId: string;
  parentId: string | null;
  spawnToolCallId: string | null;
  kind: 'main' | 'subagent';
  title: string | null;
  agentName: string | null;
  runtime: string;
  runtimeVersion: string | null;
  startedAt: string;
}

/** A block that does not come from the model: user text, a tool result, an attachment or a summary. */
export interface InputRecord { type: 'input'; block: Block; opensTurn: boolean }
/** One model call: the blocks of its answer, timing, usage and the logged context. */
export interface CallRecord {
  type: 'call';
  blocks: Block[];
  requestId: string | null;
  model: string | null;
  startTs: string;
  endTs: string;
  usage: Usage | null;
  stopReason: string | null;
  promptHash: string | null;
  context: ContextDelta | null;
}
export interface CompactionRecord { type: 'compaction'; ts: string; trigger: string | null; preTokens: number | null; postTokens: number | null }
export interface ErrorRecord { type: 'error'; ts: string; message: string; attempt: number | null; maxAttempts: number | null; retryInMs: number | null }
export interface TurnEndRecord { type: 'turn_end'; ts: string; durationMs: number }
export interface PromptRecord { type: 'prompt'; hash: string; system: string; tools: unknown[]; ts: string }
export type CaptureRecord = InputRecord | CallRecord | CompactionRecord | ErrorRecord | TurnEndRecord | PromptRecord;

export interface MessageRow {
  session_id: string; msg_seq: number; ts: string; content_hash: string; msg_role: Role; kind: BlockKind; api_msg: number;
  event_seq: number | null; tool_name: string | null; tool_call_id: string | null; is_error: boolean | null;
  bytes: number; tokens: number; truncated: boolean; text: string; payload: unknown;
}

export interface EventRow {
  session_id: string; seq: number; ts: string; turn: number; step: number; kind: EventKind;
  parent_seq: number | null; name: string | null; status: '' | 'ok' | 'error'; error: string | null;
  end_ts: string | null; duration_us: number | null; ttft_us: number | null; gap_us: number;
  model: string | null; stop_reason: string | null; request_id: string | null; attempt: number | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  ctx_msgs: number | null; ctx_prefix: number | null; ctx_change: CtxChange | null; ctx_exact: boolean | null; prompt_hash: string | null;
  msg_seq: number | null; result_msg: number | null; tool_call_id: string | null; resource: string | null;
  args: unknown; args_hash: string | null; repeat_of: number | null; repeat_visible: boolean | null;
  trace_id: string | null; span_id: string | null; attrs: unknown;
}

export interface ContextRow { session_id: string; seq: number; rel: 'in' | 'out'; pos: number; ts: string; from_msg: number; to_msg: number }
export interface PromptRow { prompt_hash: string; system_text: string; tools: unknown; tool_names: string[]; bytes: number; first_seen: string }

export interface Normalised {
  session: SessionRecord;
  messages: MessageRow[];
  events: EventRow[];
  contexts: ContextRow[];
  prompts: PromptRow[];
  /** Tool call id to the seq of its event, for linking sub-agents to the call that spawned them. */
  toolCallSeqs: ReadonlyMap<string, number>;
}

/** ISO 8601 (UTC) to a Doris DATETIME(6) string. */
export function dorisTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '000');
}

/** A Doris DATETIME(6) string (UTC) to epoch milliseconds. */
export function dorisMs(t: string): number {
  return Date.parse(`${t.slice(0, 23).replace(' ', 'T')}Z`);
}
