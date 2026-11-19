// Source inference (spec 5.9): a memory whose agent did not record the session that wrote it is
// matched by its words against the first input and the assistant text of the sessions of the same
// agent before it; the session holding more than half of its words is its inferred source, with
// that share as its score. The words leave out common words and headings.

import { CompileError, sqlString } from '../search/compile.ts';
import type { Statement } from '../trajectory/query.ts';
import type { MemoryRecord, SourceKind } from './model.ts';

/** A memory with fewer words than this is not matched: a few words fit too many sessions. */
export const MIN_WORDS = 5;
/** The words a memory is matched by, at most. */
export const MAX_WORDS = 40;
/** The share of its words a session must hold, and pass, to be a memory's inferred source. */
export const INFER_SHARE = 0.5;

const COMMON = new Set([
  'about', 'above', 'after', 'again', 'also', 'been', 'before', 'being', 'below', 'between', 'both', 'could', 'does', 'doing', 'down',
  'during', 'each', 'even', 'every', 'from', 'have', 'having', 'here', 'into', 'just', 'many', 'more', 'most', 'much', 'must', 'none',
  'once', 'other', 'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'under', 'until', 'upon', 'very', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'within',
  'without', 'would', 'your', 'yours',
]);
const WORD = /^[a-z0-9_]+$/;

/** The words a memory is matched by: those of its description and of its sections' text (its content when it has none), in order. */
export function memoryWords(m: MemoryRecord): string[] {
  const body = m.sections.length ? m.sections.map((s) => s.text) : [m.content];
  const text = [m.description ?? '', ...body].join('\n').toLowerCase();
  const words = (text.match(/[a-z0-9_]{4,}/g) ?? []).filter((w) => !COMMON.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, MAX_WORDS);
}

/** The session of the same agent before the memory that holds the most of its words, with how many. */
export function inferSourceSql(db: string, m: MemoryRecord, words: readonly string[]): Statement {
  if (!words.length || words.some((w) => !WORD.test(w))) throw new CompileError('a memory is matched by words of letters and digits; this is not a word');
  const any = sqlString(words.join(' '));
  const before = `s.kind = 'main' AND s.runtime = ${sqlString(m.agent)} AND s.started_at < ${sqlString(m.updated_at)}`;
  const found = words.map((w) => `max(if(regexp(t, ${sqlString(`(^|[^a-z0-9_])${w}([^a-z0-9_]|$)`)}), 1, 0))`).join(' + ');
  return {
    title: 'Source of the memory',
    sql: [
      'WITH texts AS (',
      '  SELECT s.session_id, lower(s.first_input) AS t',
      `  FROM ${db}.agent_sessions s`,
      `  WHERE ${before} AND s.first_input MATCH_ANY ${any}`,
      '  UNION ALL',
      '  SELECT m.session_id, lower(m.text) AS t',
      `  FROM ${db}.agent_messages m`,
      `  JOIN ${db}.agent_sessions s ON s.session_id = m.session_id`,
      `  WHERE ${before} AND m.msg_role = 'assistant' AND m.kind = 'text' AND m.text MATCH_ANY ${any}`,
      ')',
      `SELECT session_id, ${found} AS found`,
      'FROM texts',
      'GROUP BY session_id',
      'ORDER BY found DESC, session_id',
      'LIMIT 1',
    ].join('\n'),
  };
}

export interface Source { source_session_id: string | null; source_kind: SourceKind; source_score: number | null }
export const NO_SOURCE: Source = { source_session_id: null, source_kind: 'none', source_score: null };

/** The source the best session gives: inferred when it holds more than half of the words, else none. */
export function sourceOf(rows: readonly Record<string, unknown>[], words: readonly string[]): Source {
  const best = rows[0];
  if (!best || !words.length) return NO_SOURCE;
  const share = Number(best.found) / words.length;
  return share > INFER_SHARE ? { source_session_id: String(best.session_id), source_kind: 'inferred', source_score: Math.round(share * 1000) / 1000 } : NO_SOURCE;
}
