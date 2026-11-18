// Per-session totals for agent_sessions (spec 5.1): one aggregate over the stored events and
// messages, then a main session's row adds up its whole tree.

import { escape } from 'mysql2';
import type { Row } from '../../db/doris.ts';
import { dorisMs, dorisTime, type SessionRecord } from '../trajectory/model.ts';

export const SOURCE = 'claude-transcript';
const TEXT_PREVIEW = 2000;

export interface Branch { record: SessionRecord; parentSeq: number | null }

export interface BranchTotals {
  turns: number; steps: number; tool_calls: number; tool_errors: number; compactions: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; peak_ctx_tokens: number;
  started_at: string; last_event_at: string; idle_us: number; last_seq: number; last_msg_seq: number;
  model: string | null; first_input: string | null; last_output: string | null;
}

export interface SessionRow {
  session_id: string; root_id: string; parent_id: string | null; parent_seq: number | null; kind: string;
  title: string | null; agent_name: string | null; runtime: string; runtime_version: string | null;
  service_name: string | null; user_id: string | null; model: string | null; config: unknown;
  started_at: string; last_event_at: string; last_seq: number; last_msg_seq: number;
  turns: number; steps: number; tool_calls: number; tool_errors: number; subagents: number; compactions: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  peak_ctx_tokens: number; active_us: number; first_input: string | null; last_output: string | null;
  safety_risks: number | null; source: string; source_cursor: string | null;
}

export function totalsSql(db: string, ids: readonly string[]): string {
  if (ids.length === 0) throw new Error('totalsSql: no session ids');
  const inList = ids.map((id) => escape(id)).join(', ');
  return `WITH ev AS (SELECT * FROM ${db}.agent_events WHERE session_id IN (${inList})),
t AS (
  SELECT session_id, max(turn) AS turns, sum(if(kind = 'llm_call', 1, 0)) AS steps,
    sum(if(kind = 'tool_call', 1, 0)) AS tool_calls, sum(if(kind = 'tool_call' AND status = 'error', 1, 0)) AS tool_errors,
    sum(if(kind = 'compaction', 1, 0)) AS compactions,
    sum(coalesce(input_tokens, 0)) AS input_tokens, sum(coalesce(output_tokens, 0)) AS output_tokens,
    sum(coalesce(cache_read_tokens, 0)) AS cache_read_tokens, sum(coalesce(cache_write_tokens, 0)) AS cache_write_tokens,
    max(if(kind = 'llm_call', coalesce(input_tokens, 0) + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0), 0)) AS peak_ctx_tokens,
    min(ts) AS started_at, max(coalesce(end_ts, ts)) AS last_event_at,
    sum(if(kind = 'user_input', gap_us, 0)) AS idle_us, max(seq) AS last_seq,
    min_by(model, if(kind = 'llm_call', seq, NULL)) AS model
  FROM ev GROUP BY session_id
),
fi AS (
  SELECT e.session_id, min_by(m.text, e.seq) AS first_input
  FROM ev e JOIN ${db}.agent_messages m ON m.session_id = e.session_id AND m.msg_seq = e.msg_seq
  WHERE e.kind = 'user_input' GROUP BY e.session_id
),
lo AS (
  SELECT session_id, max(msg_seq) AS last_msg_seq,
    max_by(text, if(msg_role = 'assistant' AND kind = 'text', msg_seq, NULL)) AS last_output
  FROM ${db}.agent_messages WHERE session_id IN (${inList}) GROUP BY session_id
)
SELECT t.*, substr(fi.first_input, 1, ${TEXT_PREVIEW}) AS first_input, lo.last_msg_seq, substr(lo.last_output, 1, ${TEXT_PREVIEW}) AS last_output
FROM t LEFT JOIN fi ON fi.session_id = t.session_id LEFT JOIN lo ON lo.session_id = t.session_id`;
}

const NUMERIC = ['turns', 'steps', 'tool_calls', 'tool_errors', 'compactions', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'peak_ctx_tokens', 'idle_us', 'last_seq', 'last_msg_seq'] as const;
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function totalsFromRows(rows: readonly Row[]): Map<string, BranchTotals> {
  return new Map(rows.map((r) => {
    const nums = Object.fromEntries(NUMERIC.map((k) => [k, Number(r[k] ?? 0)])) as Record<(typeof NUMERIC)[number], number>;
    return [String(r.session_id), { ...nums, started_at: String(r.started_at), last_event_at: String(r.last_event_at),
      model: text(r.model), first_input: text(r.first_input), last_output: text(r.last_output) }];
  }));
}

function emptyTotals(record: SessionRecord): BranchTotals {
  const at = dorisTime(record.startedAt);
  return { turns: 0, steps: 0, tool_calls: 0, tool_errors: 0, compactions: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, peak_ctx_tokens: 0, started_at: at, last_event_at: at, idle_us: 0, last_seq: 0, last_msg_seq: 0,
    model: null, first_input: null, last_output: null };
}

export function sessionRows(branches: readonly Branch[], totals: ReadonlyMap<string, BranchTotals>, cursor: string): SessionRow[] {
  const of = (b: Branch) => totals.get(b.record.id) ?? emptyTotals(b.record);
  return branches.map((b) => {
    const own = of(b);
    const main = b.record.kind === 'main';
    const scope = main ? branches.map(of) : [own];
    const sum = (k: 'steps' | 'tool_calls' | 'tool_errors' | 'compactions' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens') =>
      scope.reduce((a, t) => a + t[k], 0);
    const last = scope.map((t) => t.last_event_at).reduce((a, x) => (x > a ? x : a));
    return {
      session_id: b.record.id, root_id: b.record.rootId, parent_id: b.record.parentId, parent_seq: b.parentSeq, kind: b.record.kind,
      title: b.record.title, agent_name: b.record.agentName, runtime: b.record.runtime, runtime_version: b.record.runtimeVersion,
      service_name: null, user_id: null, model: own.model, config: null,
      started_at: own.started_at, last_event_at: last, last_seq: own.last_seq, last_msg_seq: own.last_msg_seq,
      turns: own.turns, steps: sum('steps'), tool_calls: sum('tool_calls'), tool_errors: sum('tool_errors'),
      subagents: main ? branches.length - 1 : branches.filter((x) => x.record.parentId === b.record.id).length,
      compactions: sum('compactions'), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
      cache_read_tokens: sum('cache_read_tokens'), cache_write_tokens: sum('cache_write_tokens'),
      peak_ctx_tokens: Math.max(...scope.map((t) => t.peak_ctx_tokens)),
      active_us: Math.max(0, (dorisMs(last) - dorisMs(own.started_at)) * 1000 - own.idle_us),
      first_input: own.first_input, last_output: own.last_output, safety_risks: null, source: SOURCE, source_cursor: main ? cursor : null,
    };
  });
}
