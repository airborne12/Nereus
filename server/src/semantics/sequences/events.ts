// The events a sequence is made of (spec 8.5), as a common table expression: the user inputs, tool
// calls, replies that end a turn and compactions of a time range, numbered in the order of their
// session. `what` names an event as the page does; `target` is what a tool call acts on, or the
// text of an input or reply.

import type { StepKind } from './pattern.ts';

export interface Range { cond: (col: string) => string; loose: (col: string) => string }

/** The value of `agent_events.kind` for each kind of step. */
export const EVENT_KIND: Record<StepKind, string> = { call: 'tool_call', user: 'user_input', reply: 'llm_call', compaction: 'compaction' };

const WHAT = "CASE e.kind WHEN 'tool_call' THEN e.name WHEN 'user_input' THEN 'User input' WHEN 'llm_call' THEN 'Reply' ELSE 'Compaction' END";
/** A tool call acts on its resource; a tool without a resource rule is known by its arguments. */
const CALL_TARGET = "coalesce(e.resource, CAST(e.args AS STRING), '')";
const IN_SEQUENCE = "(e.kind IN ('user_input', 'tool_call', 'compaction') OR (e.kind = 'llm_call' AND e.stop_reason = 'end_turn'))";

/**
 * The expressions that number the events, named `name`.
 * `target` says how much of the target is read: none, that of tool calls, or the text of inputs
 * and replies too, which joins the message blocks.
 */
export function eventsCtes(db: string, range: Range, name: string, target: 'none' | 'calls' | 'text'): string[] {
  const text = target === 'text';
  const targetSql = target === 'none' ? [] : [text
    ? `CASE e.kind WHEN 'tool_call' THEN ${CALL_TARGET} WHEN 'compaction' THEN '' ELSE coalesce(if(m.kind = 'text', m.text, NULL), x.text, '') END AS target`
    : `CASE WHEN e.kind = 'tool_call' THEN ${CALL_TARGET} ELSE '' END AS target`];
  const joins = text ? [
    // An input's block is the one the event names. A repeated input keeps its first block, so no lower bound in time.
    `  LEFT JOIN ${db}.agent_messages m ON m.session_id = e.session_id AND m.msg_seq = e.msg_seq AND e.kind IN ('user_input', 'llm_call')`,
    "  LEFT JOIN texts x ON x.session_id = e.session_id AND x.event_seq = e.seq AND e.kind = 'llm_call'",
  ] : [];
  const texts = text ? [[
    'texts AS (',
    "  SELECT session_id, event_seq, group_concat(text, '\\n' ORDER BY msg_seq) AS text",
    `  FROM ${db}.agent_messages`,
    `  WHERE kind = 'text' AND msg_role = 'assistant' AND ${range.loose('ts')}`,
    '  GROUP BY session_id, event_seq',
    ')',
  ].join('\n')] : [];
  const numbered = [
    `${name} AS (`,
    `  SELECT e.session_id, e.seq, e.ts, e.turn, e.step, e.kind, e.parent_seq, ${WHAT} AS what,`,
    `         e.status, ${[...targetSql, 'row_number() OVER (PARTITION BY e.session_id ORDER BY e.seq) AS pos'].join(',\n         ')}`,
    `  FROM ${db}.agent_events e`,
    ...joins,
    `  WHERE ${IN_SEQUENCE}`,
    `    AND ${range.cond('e.ts')}`,
    ')',
  ].join('\n');
  return [...texts, numbered];
}
