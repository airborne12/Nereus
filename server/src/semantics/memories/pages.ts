// The memories as the pages read them (spec 7, 8.8): the Memories table with the latest version of
// each memory, one memory with its versions and the calls that read or wrote it, and the memories a
// session tree wrote. Whether a memory still holds is judged by the validity fold; until a session
// has read it since it was written, it is not used, and for a format whose reads are not recorded
// as events its use is not recorded.

import { sqlString } from '../search/compile.ts';
import type { ColumnKind, Page, PageColumn, Statement } from '../trajectory/query.ts';
import { READ_RECORDED } from './model.ts';
import { latestStateSql, subjectSql, VALIDITY } from './validity.ts';
import { REMOVED } from './statements.ts';

export interface MemoryRef { agent: string; scope: string; name: string }
/** The state of a memory: the latest of the validity fold, or what is known before it has judged it. */
export type MemoryState = 'removed' | 'unrecorded' | 'unused' | 'unjudged' | 'holds' | 'doubt' | 'outdated';

const READ = 'Read';
const WRITES = ['Write', 'Edit', 'MultiEdit'];
const list = (xs: readonly string[]): string => xs.map(sqlString).join(', ');

const col = (name: string, expr: string, kind: ColumnKind, extra: Partial<PageColumn> = {}): PageColumn => ({ name, expr, kind, ...extra });

/** Whether a memory `m` still holds: the latest state `v` of the fold, else whether the latest read `r` of its file came after it was written. */
export const stillValidCase = (m: string, r: string, v: string): string =>
  `CASE WHEN ${m}.format NOT IN (${list(READ_RECORDED)}) THEN 'unrecorded' WHEN ${v}.state IS NOT NULL THEN ${v}.state WHEN ${r}.last_read IS NULL OR ${r}.last_read <= ${m}.updated_at THEN 'unused' ELSE 'unjudged' END`;

/** A row is the latest version of a memory still in its store. */
export function memoriesPage(db: string): Page {
  return {
    name: 'memories',
    from: () => [
      `FROM (SELECT agent, scope, name, max(captured_at) AS captured_at FROM ${db}.agent_memories GROUP BY agent, scope, name) l`,
      `JOIN ${db}.agent_memories m ON m.agent = l.agent AND m.scope = l.scope AND m.name = l.name AND m.captured_at = l.captured_at`,
      `LEFT JOIN (SELECT resource, max(ts) AS last_read FROM ${db}.agent_events WHERE kind = 'tool_call' AND name = ${sqlString(READ)} AND resource IN (SELECT location FROM ${db}.agent_memories) GROUP BY resource) r ON r.resource = m.location`,
      `LEFT JOIN ${db}.agent_sessions src ON src.session_id = m.source_session_id`,
      `LEFT JOIN ${latestStateSql(db)} v ON v.subject = ${subjectSql('m')}`,
    ],
    fixed: [`m.content_hash <> ${sqlString(REMOVED)}`],
    time: 'm.updated_at',
    keys: ['agent', 'scope', 'name'],
    search: (t) => `(m.name MATCH_PHRASE ${sqlString(t)} OR m.description MATCH_PHRASE ${sqlString(t)} OR m.content MATCH_PHRASE ${sqlString(t)})`,
    defaultSort: 'updated_at',
    columns: [
      col('updated_at', 'm.updated_at', 'time'),
      col('agent', 'm.agent', 'text'),
      col('scope', 'm.scope', 'text'),
      col('name', 'm.name', 'text', { indexed: true }),
      col('description', 'm.description', 'text', { indexed: true, long: true }),
      col('kind', 'm.kind', 'text'),
      col('still_valid', stillValidCase('m', 'r', 'v'), 'text'),
      col('source_session_id', 'm.source_session_id', 'text'),
      col('source_root_id', 'src.root_id', 'text'),
      col('source_title', 'src.title', 'text'),
      col('source_kind', 'm.source_kind', 'text'),
      col('source_score', 'm.source_score', 'number'),
      col('format', 'm.format', 'text'),
      col('captured_at', 'm.captured_at', 'time'),
    ],
  };
}

const keyOf = (ref: MemoryRef): string => `m.agent = ${sqlString(ref.agent)} AND m.scope = ${sqlString(ref.scope)} AND m.name = ${sqlString(ref.name)}`;

/** One memory: its versions, newest first, with the session each came from; the calls that read or wrote its file; the states of its latest version. */
export function memorySql(db: string, ref: MemoryRef): { versions: Statement; uses: Statement; history: Statement } {
  return {
    history: {
      title: 'States of the memory',
      sql: [
        'SELECT j.version, j.judged_at, j.session_id, s.root_id, s.title, j.seq, j.evidence, j.state, j.reason, j.model',
        `FROM ${db}.agent_judgments j`,
        `LEFT JOIN ${db}.agent_sessions s ON s.session_id = j.session_id`,
        `WHERE j.judge = ${sqlString(VALIDITY.judge)} AND j.subject IN (SELECT ${subjectSql('m')} FROM ${db}.agent_memories m`,
        `  WHERE ${keyOf(ref)} AND m.captured_at = (SELECT max(captured_at) FROM ${db}.agent_memories m WHERE ${keyOf(ref)}))`,
        'ORDER BY j.version DESC',
        'LIMIT 100',
      ].join('\n'),
    },
    versions: {
      title: 'Versions of the memory',
      sql: [
        'SELECT m.captured_at, m.updated_at, m.format, m.location, m.description, m.kind, m.content, CAST(m.sections AS STRING) AS sections, CAST(m.fields AS STRING) AS fields,',
        '       m.content_hash, m.source_session_id, m.source_kind, m.source_score, src.root_id AS source_root_id, src.title AS source_title',
        `FROM ${db}.agent_memories m`,
        `LEFT JOIN ${db}.agent_sessions src ON src.session_id = m.source_session_id`,
        `WHERE ${keyOf(ref)}`,
        'ORDER BY m.captured_at DESC',
        'LIMIT 50',
      ].join('\n'),
    },
    uses: {
      title: 'Calls that read or wrote it',
      sql: [
        'SELECT e.session_id, s.root_id, s.title, e.seq, e.parent_seq, e.ts, e.turn, e.step, e.name',
        `FROM ${db}.agent_events e`,
        `JOIN ${db}.agent_sessions s ON s.session_id = e.session_id`,
        `WHERE e.kind = 'tool_call' AND e.name IN (${list([READ, ...WRITES])})`,
        `  AND e.resource IN (SELECT DISTINCT location FROM ${db}.agent_memories m WHERE ${keyOf(ref)})`,
        'ORDER BY e.ts DESC, e.session_id, e.seq',
        'LIMIT 100',
      ].join('\n'),
    },
  };
}

/** The state of a memory from its latest version, the calls that used it and the states of the fold, each newest first. */
export function memoryState(latest: Record<string, unknown>, uses: readonly Record<string, unknown>[], history: readonly Record<string, unknown>[] = []): MemoryState {
  if (latest.content_hash === REMOVED) return 'removed';
  if (!(READ_RECORDED as readonly string[]).includes(String(latest.format))) return 'unrecorded';
  const state = history[0]?.state;
  if (state === 'holds' || state === 'doubt' || state === 'outdated') return state;
  const since = String(latest.updated_at);
  return uses.some((u) => u.name === READ && String(u.ts) > since) ? 'unjudged' : 'unused';
}

/** The memories the sessions of a tree wrote: recorded as their source, or whose file a call of theirs wrote. */
export function wroteSql(db: string, ids: readonly string[]): Statement {
  const sessions = list(ids);
  return {
    title: 'Memories written',
    sql: [
      'SELECT DISTINCT m.agent, m.scope, m.name',
      `FROM ${db}.agent_memories m`,
      `WHERE m.content_hash <> ${sqlString(REMOVED)} AND ((m.source_kind = 'recorded' AND m.source_session_id IN (${sessions}))`,
      `  OR m.location IN (SELECT resource FROM ${db}.agent_events WHERE session_id IN (${sessions}) AND kind = 'tool_call' AND name IN (${list(WRITES)})))`,
      'ORDER BY m.name',
    ].join('\n'),
  };
}
