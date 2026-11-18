// Statements of the session page (spec 7 and 8.3): the session tree, one row per turn, the light
// step rows the lanes draw, and what the right side reads for a turn, a step or a compaction.

import { CompileError, sqlString } from '../search/compile.ts';
import { CTX_TOKENS } from './pages.ts';
import type { Statement } from './query.ts';

/** Steps of one turn the lanes get at a time. */
export const STEPS_PAGE = 100;
/** Context blocks of a step's input sent at a time. */
export const INPUT_PAGE = 100;
/** Characters of one block's text sent to the page; the rest is cut and `chars` says how much there is. */
export const BLOCK_CHARS = 100_000;
/** A tree with at most this many steps opens with every turn open (8.3). */
export const OPEN_ALL_STEPS = 40;

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A session id as it appears in a path; anything else is refused before it reaches SQL. */
export function sessionId(id: string): string {
  if (!ID.test(id)) throw new CompileError('bad session id');
  return id;
}

/** A number used as a count, offset or sequence number; anything else is refused before it reaches SQL. */
function count(n: number, name: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new CompileError(`'${name}' must be a whole number from 0`);
  return n;
}

const TREE = ['session_id', 'root_id', 'parent_id', 'parent_seq', 'kind', 'agent_name', 'title', 'model', 'runtime', 'runtime_version',
  'user_id', 'started_at', 'last_event_at', 'last_seq', 'turns', 'steps', 'tool_calls', 'tool_errors', 'subagents', 'compactions',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'peak_ctx_tokens', 'active_us', 'safety_risks', 'first_input', 'last_output'];

/** The tree of the session `id` belongs to; a sub-agent id opens its whole tree. */
export function treeSql(db: string, id: string): Statement {
  const root = `(SELECT root_id FROM ${db}.agent_sessions WHERE session_id = ${sqlString(sessionId(id))})`;
  return { title: 'Session', sql: `SELECT ${TREE.join(', ')}\nFROM ${db}.agent_sessions\nWHERE root_id = ${root}\nORDER BY started_at, session_id` };
}

/** The trees of the given main sessions, for Compare. */
export function treeSqlFor(db: string, roots: readonly string[]): Statement {
  const list = roots.map((id) => sqlString(sessionId(id))).join(', ');
  return { title: 'Sessions', sql: `SELECT ${TREE.join(', ')}\nFROM ${db}.agent_sessions\nWHERE root_id IN (${list})\nORDER BY root_id, started_at, session_id` };
}

/** One row per turn of the given branches, with what a closed turn shows. */
export function turnsSql(db: string, ids: readonly string[]): Statement {
  const list = ids.map((id) => sqlString(sessionId(id))).join(', ');
  return {
    title: 'Turns',
    sql: `SELECT t.session_id, t.turn, t.started_at, t.ended_at, u.text AS user_input, t.steps, t.failed_calls, t.compactions,
       t.active_us, t.ctx_first, t.ctx_last, t.tools, t.first_step, t.last_call, t.ctx_exact
FROM (
  SELECT e.session_id, e.turn, min(e.ts) AS started_at, max(coalesce(e.end_ts, e.ts)) AS ended_at,
         max(if(e.kind = 'user_input', e.msg_seq, NULL)) AS asked,
         sum(if(e.kind = 'llm_call', 1, 0)) AS steps,
         sum(if(e.kind = 'tool_call' AND e.status = 'error', 1, 0)) AS failed_calls,
         sum(if(e.kind = 'compaction', 1, 0)) AS compactions,
         sum(if(e.kind IN ('llm_call', 'tool_call'), coalesce(e.duration_us, 0), 0)) AS active_us,
         min_by(${CTX_TOKENS}, if(e.kind = 'llm_call', e.seq, NULL)) AS ctx_first,
         max_by(${CTX_TOKENS}, if(e.kind = 'llm_call', e.seq, NULL)) AS ctx_last,
         group_concat(if(e.kind = 'tool_call', concat(e.name, if(e.status = 'error', ' failed', '')), NULL), ',' ORDER BY e.seq) AS tools,
         min(if(e.kind = 'llm_call', e.step, NULL)) AS first_step,
         max(if(e.kind = 'llm_call', e.seq, NULL)) AS last_call,
         min(if(e.kind = 'llm_call', if(e.ctx_exact, 1, 0), NULL)) AS ctx_exact
  FROM ${db}.agent_events e
  WHERE e.session_id IN (${list})
  GROUP BY e.session_id, e.turn
) t
LEFT JOIN ${db}.agent_messages u ON u.session_id = t.session_id AND u.msg_seq = t.asked
ORDER BY t.session_id, t.turn`,
  };
}

/** Most rows the marks of a tree carry. */
export const MARKS_LIMIT = 2000;

/**
 * What the Jump to buttons visit, and where each sub-agent branch leaves its parent: the failed
 * and repeated tool calls, the calls that started a sub-agent, and the compactions of the branches.
 * The page cannot draw a tree without the last two, so they come first; one row more than
 * MARKS_LIMIT is read so the route can say when marks were cut.
 */
export function marksSql(db: string, ids: readonly string[]): Statement {
  const list = ids.map((id) => sqlString(sessionId(id))).join(', ');
  return {
    title: 'Marks',
    sql: `SELECT e.session_id, e.seq, e.turn, e.step, e.kind, e.parent_seq,
       if(e.status = 'error', 1, 0) AS failed, if(e.repeat_of IS NOT NULL, 1, 0) AS repeated, c.session_id AS child
FROM ${db}.agent_events e
LEFT JOIN ${db}.agent_sessions c ON c.parent_id = e.session_id AND c.parent_seq = e.seq
WHERE e.session_id IN (${list})
  AND (e.kind = 'compaction' OR (e.kind = 'tool_call' AND (e.status = 'error' OR e.repeat_of IS NOT NULL OR c.session_id IS NOT NULL)))
ORDER BY if(e.kind = 'compaction' OR c.session_id IS NOT NULL, 0, 1), e.session_id, e.seq
LIMIT ${MARKS_LIMIT + 1}`,
  };
}

/** Columns of a light step row: model calls, tool calls and compactions, as the lanes draw them. */
const LIGHT = `e.session_id, e.seq, e.ts, e.turn, e.step, e.kind, e.parent_seq, e.name, e.resource, e.status, e.duration_us,
       ${CTX_TOKENS} AS ctx_tokens, e.ctx_msgs, e.ctx_change, e.ctx_exact, e.repeat_of, e.repeat_visible, e.stop_reason`;

/** Every light step row of the given branches; used when the whole tree opens at once. */
export function treeStepsSql(db: string, ids: readonly string[]): Statement {
  const list = ids.map((id) => sqlString(sessionId(id))).join(', ');
  return {
    title: 'Steps',
    sql: `SELECT ${LIGHT}\nFROM ${db}.agent_events e\nWHERE e.session_id IN (${list}) AND e.kind IN ('llm_call', 'tool_call', 'compaction')\nORDER BY e.session_id, e.seq`,
  };
}

/**
 * One page of the steps of a turn: the model calls numbered offset + 1 to offset + STEPS_PAGE in
 * the turn, with their tool calls; a compaction before the turn's first call belongs to page one.
 */
export function turnStepsSql(db: string, id: string, turn: number, offset: number): Statement {
  const t = count(turn, 'turn');
  const from = count(offset, 'offset');
  return {
    title: `Steps of turn ${t}`,
    sql: `SELECT * FROM (
  SELECT ${LIGHT},
         greatest(sum(if(e.kind = 'llm_call', 1, 0)) OVER (ORDER BY e.seq), 1) AS nth
  FROM ${db}.agent_events e
  WHERE e.session_id = ${sqlString(sessionId(id))} AND e.turn = ${t} AND e.kind IN ('llm_call', 'tool_call', 'compaction')
) x
WHERE nth > ${from} AND nth <= ${from + STEPS_PAGE}
ORDER BY seq`,
  };
}

const BLOCK = `m.msg_seq, m.ts, m.msg_role, m.kind, m.api_msg, m.event_seq, m.tool_name, m.tool_call_id, m.is_error, m.tokens, m.truncated,
       left(m.text, ${BLOCK_CHARS}) AS text, char_length(m.text) AS chars`;

/** A turn as the right side reads it: what the user asked and the text of the turn's last model call. */
export function turnSql(db: string, id: string, turn: number): Statement {
  const sid = sqlString(sessionId(id));
  const t = count(turn, 'turn');
  return {
    title: `Turn ${t}`,
    sql: `SELECT ${BLOCK}
FROM (
  SELECT max(if(kind = 'user_input', msg_seq, NULL)) AS asked, max(if(kind = 'llm_call', seq, NULL)) AS last_call
  FROM ${db}.agent_events
  WHERE session_id = ${sid} AND turn = ${t}
) t
JOIN ${db}.agent_messages m ON m.session_id = ${sid} AND (m.msg_seq = t.asked OR (m.event_seq = t.last_call AND m.kind = 'text'))
ORDER BY m.msg_seq`,
  };
}

/** The statements of a step (one model call): its event, its input one page at a time, its output and its prompt. */
export function stepSql(db: string, id: string, seq: number, inputOffset: number): { event: Statement; input: Statement; output: Statement; prompt: Statement } {
  const sid = sqlString(sessionId(id));
  const at = count(seq, 'seq');
  const skip = count(inputOffset, 'inputOffset');
  const context = `FROM ${db}.agent_contexts c
JOIN ${db}.agent_messages m ON m.session_id = c.session_id AND m.msg_seq BETWEEN c.from_msg AND c.to_msg
WHERE c.session_id = ${sid} AND c.seq = ${at} AND c.rel = 'in'`;
  return {
    event: { title: 'Step', sql: `SELECT *\nFROM ${db}.agent_events\nWHERE session_id = ${sid} AND seq = ${at} AND kind = 'llm_call'` },
    // Latest first: the blocks new in this request come before the ones earlier requests had.
    input: { title: 'Input', sql: `SELECT c.pos, ${BLOCK}\n${context}\nORDER BY c.pos DESC, m.msg_seq DESC\nLIMIT ${INPUT_PAGE} OFFSET ${skip}` },
    output: {
      title: 'Output',
      sql: `SELECT ${BLOCK}, m.payload,
       e.kind AS event_kind, e.name, e.resource, e.status, e.duration_us, e.repeat_of, e.repeat_visible
FROM ${db}.agent_events e
JOIN ${db}.agent_messages m ON m.session_id = e.session_id AND m.event_seq = e.seq
WHERE e.session_id = ${sid} AND (e.seq = ${at} OR e.parent_seq = ${at})
ORDER BY m.msg_seq`,
    },
    prompt: {
      title: 'Prompt',
      sql: `SELECT p.prompt_hash, p.system_text, p.tools, p.tool_names, p.bytes
FROM ${db}.agent_prompts p
WHERE p.prompt_hash = (SELECT prompt_hash FROM ${db}.agent_events WHERE session_id = ${sid} AND seq = ${at})`,
    },
  };
}

/**
 * A compaction as the right side reads it: the event, the blocks the next model call no longer
 * saw, and the summary that call saw instead.
 */
export function compactionSql(db: string, id: string, seq: number): { event: Statement; blocks: Statement } {
  const sid = sqlString(sessionId(id));
  const at = count(seq, 'seq');
  return {
    event: { title: 'Compaction', sql: `SELECT *\nFROM ${db}.agent_events\nWHERE session_id = ${sid} AND seq = ${at} AND kind = 'compaction'` },
    blocks: {
      title: 'Replaced and summary',
      sql: `SELECT c.rel, c.pos, ${BLOCK}
FROM ${db}.agent_contexts c
JOIN ${db}.agent_messages m ON m.session_id = c.session_id AND m.msg_seq BETWEEN c.from_msg AND c.to_msg
WHERE c.session_id = ${sid}
  AND c.seq = (SELECT min(seq) FROM ${db}.agent_events WHERE session_id = ${sid} AND kind = 'llm_call' AND seq > ${at})
  AND (c.rel = 'out' OR m.kind = 'summary')
ORDER BY c.rel DESC, m.msg_seq`,
    },
  };
}
