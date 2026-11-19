// The column catalogues of the Sessions, Steps and Messages pages (spec 8.2): which tables a page
// reads, what each column is, and how a search term narrows the rows.

import { sqlString } from '../search/compile.ts';
import type { ColumnKind, Page, PageColumn } from './query.ts';

const col = (name: string, expr: string, kind: ColumnKind, extra: Partial<PageColumn> = {}): PageColumn => ({ name, expr, kind, ...extra });

/** Tokens of the request a model call sent: its context size. */
export const CTX_TOKENS = 'coalesce(e.input_tokens, 0) + coalesce(e.cache_read_tokens, 0) + coalesce(e.cache_write_tokens, 0)';

/** A row is a main session with its tree; its counts cover the tree. */
export function sessionsPage(db: string): Page {
  return {
    name: 'sessions',
    from: () => [
      `FROM ${db}.agent_sessions s`,
      // The rules a tree broke, by name; a tree has few risks, so the table is small.
      `LEFT JOIN (SELECT root_id, array_join(array_sort(collect_set(rule_name)), '\\n') AS rules FROM ${db}.agent_risks GROUP BY root_id) k ON k.root_id = s.session_id`,
    ],
    fixed: ["s.kind = 'main'"],
    time: 's.last_event_at',
    keys: ['session_id'],
    search: (t) => `(s.title MATCH_PHRASE ${sqlString(t)} OR s.first_input MATCH_PHRASE ${sqlString(t)} OR s.last_output MATCH_PHRASE ${sqlString(t)})`,
    defaultSort: 'last_event_at',
    columns: [
      col('last_event_at', 's.last_event_at', 'time'),
      col('session_id', 's.session_id', 'text'),
      col('title', 's.title', 'text', { indexed: true }),
      col('tool_errors', 's.tool_errors', 'number'),
      col('safety_risks', 's.safety_risks', 'number'),
      // Unset, like the count, while the rules have not run since the last import.
      col('risk_rules', 'if(s.safety_risks IS NULL, NULL, k.rules)', 'text'),
      col('first_input', 's.first_input', 'text', { indexed: true, long: true }),
      col('last_output', 's.last_output', 'text', { indexed: true, long: true }),
      col('turns', 's.turns', 'number'),
      col('steps', 's.steps', 'number'),
      col('tokens', 's.input_tokens + s.output_tokens', 'number'),
      col('started_at', 's.started_at', 'time'),
      col('active_us', 's.active_us', 'number'),
      col('subagents', 's.subagents', 'number'),
      col('compactions', 's.compactions', 'number'),
      col('peak_ctx_tokens', 's.peak_ctx_tokens', 'number'),
      col('model', 's.model', 'text'),
      col('user_id', 's.user_id', 'text'),
      col('runtime', 's.runtime', 'text'),
      col('runtime_version', 's.runtime_version', 'text'),
      col('input_tokens', 's.input_tokens', 'number'),
      col('output_tokens', 's.output_tokens', 'number'),
      col('cache_read_tokens', 's.cache_read_tokens', 'number'),
      col('cache_write_tokens', 's.cache_write_tokens', 'number'),
    ],
  };
}

/**
 * A row is one model call with the tool calls it issued, sub-agents included. A search term must
 * occur in what the assistant wrote or called in that step: each term joins the API messages of
 * assistant blocks that contain it, so the match stays on the indexed text column.
 */
export function stepsPage(db: string): Page {
  return {
    name: 'steps',
    from: (range, terms) => [
      `FROM ${db}.agent_events e`,
      `JOIN ${db}.agent_sessions s ON s.session_id = e.session_id`,
      `LEFT JOIN ${db}.agent_messages m ON m.session_id = e.session_id AND m.msg_seq = e.msg_seq`,
      'LEFT JOIN (',
      "  SELECT session_id, parent_seq, group_concat(concat_ws(' ', name, resource), ', ' ORDER BY seq) AS calls,",
      "         sum(if(status = 'error', 1, 0)) AS failed, sum(duration_us) AS tool_us,",
      '         sum(if(repeat_of IS NOT NULL, 1, 0)) AS repeats, sum(if(repeat_visible, 1, 0)) AS repeats_seen',
      `  FROM ${db}.agent_events`,
      `  WHERE kind = 'tool_call' AND ${range('ts')}`,
      '  GROUP BY session_id, parent_seq',
      ') t ON t.session_id = e.session_id AND t.parent_seq = e.seq',
      // Retries of a model call are the API errors logged after the call before it.
      'LEFT JOIN (',
      '  SELECT session_id, step + 1 AS next_step, count(*) AS retries',
      `  FROM ${db}.agent_events`,
      `  WHERE kind = 'error' AND ${range('ts')}`,
      '  GROUP BY session_id, step',
      ') r ON r.session_id = e.session_id AND r.next_step = e.step',
      ...terms.flatMap((term, i) => [
        'JOIN (',
        `  SELECT DISTINCT session_id, api_msg FROM ${db}.agent_messages`,
        `  WHERE msg_role = 'assistant' AND ${range('ts')} AND text MATCH_PHRASE ${sqlString(term)}`,
        `) w${i} ON w${i}.session_id = m.session_id AND w${i}.api_msg = m.api_msg`,
      ]),
    ],
    fixed: ["e.kind = 'llm_call'"],
    time: 'e.ts',
    keys: ['session_id', 'seq'],
    search: null,
    defaultSort: 'ts',
    columns: [
      col('ts', 'e.ts', 'time'),
      col('session_id', 'e.session_id', 'text'),
      col('seq', 'e.seq', 'number'),
      col('root_id', 's.root_id', 'text'),
      col('title', 's.title', 'text', { indexed: true }),
      col('agent', 'coalesce(s.agent_name, s.kind)', 'text'),
      col('turn', 'e.turn', 'number'),
      col('step', 'e.step', 'number'),
      col('calls', 't.calls', 'text', { long: true }),
      col('status', "if(t.failed > 0, 'failed', 'ok')", 'text'),
      col('output', 'm.text', 'text', { indexed: true, long: true }),
      // The block a model call produced first: its text, or a tool call when it wrote none.
      col('output_kind', 'm.kind', 'text'),
      col('ctx_tokens', CTX_TOKENS, 'number'),
      col('duration_us', 'e.duration_us', 'number'),
      col('repeated_call', "CASE WHEN t.repeats_seen > 0 THEN 'still in context' WHEN t.repeats > 0 THEN 'no longer in context' ELSE '' END", 'text'),
      col('stop_reason', 'e.stop_reason', 'text'),
      col('ctx_msgs', 'e.ctx_msgs', 'number'),
      col('ctx_new', 'e.ctx_msgs - e.ctx_prefix', 'number'),
      col('ctx_change', 'e.ctx_change', 'text'),
      col('ctx_exact', 'if(e.ctx_exact, 1, 0)', 'number'),
      col('cache_pct', `round(100 * e.cache_read_tokens / nullif(${CTX_TOKENS}, 0))`, 'number'),
      col('output_tokens', 'e.output_tokens', 'number'),
      col('tool_us', 't.tool_us', 'number'),
      col('retries', 'coalesce(r.retries, 0)', 'number'),
      col('model', 'e.model', 'text'),
    ],
  };
}

/** A row is one content block, sub-agents included; a search term is a phrase in the block's text. */
export function messagesPage(db: string): Page {
  return {
    name: 'messages',
    from: () => [
      `FROM ${db}.agent_messages m`,
      `JOIN ${db}.agent_sessions s ON s.session_id = m.session_id`,
      `LEFT JOIN ${db}.agent_events e ON e.session_id = m.session_id AND e.seq = m.event_seq`,
    ],
    fixed: [],
    time: 'm.ts',
    keys: ['session_id', 'msg_seq'],
    search: (t) => `m.text MATCH_PHRASE ${sqlString(t)}`,
    defaultSort: 'ts',
    columns: [
      col('ts', 'm.ts', 'time'),
      col('session_id', 'm.session_id', 'text'),
      col('msg_seq', 'm.msg_seq', 'number'),
      col('root_id', 's.root_id', 'text'),
      col('title', 's.title', 'text', { indexed: true }),
      col('agent', 'coalesce(s.agent_name, s.kind)', 'text'),
      col('turn', 'e.turn', 'number'),
      // Only a model call or a tool call gives a block a step.
      col('step', "CASE WHEN e.kind IN ('llm_call', 'tool_call') THEN e.step END", 'number'),
      col('event_seq', 'm.event_seq', 'number'),
      col('event_kind', 'e.kind', 'text'),
      // The model call a row opens: the block's own call, or the call that issued its tool call.
      col('step_seq', "CASE WHEN e.kind = 'llm_call' THEN e.seq WHEN e.kind = 'tool_call' THEN e.parent_seq END", 'number'),
      col('msg_role', 'm.msg_role', 'text'),
      col('kind', 'm.kind', 'text'),
      col('tool_name', 'm.tool_name', 'text'),
      col('status', "CASE WHEN m.is_error THEN 'failed' WHEN m.kind = 'tool_result' THEN 'ok' ELSE '' END", 'text'),
      col('text', 'm.text', 'text', { indexed: true, long: true }),
      col('tokens', 'm.tokens', 'number'),
      col('bytes', 'm.bytes', 'number'),
    ],
  };
}
