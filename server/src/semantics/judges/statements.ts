// The SQL of a judge (spec 8.7): picking the steps, choosing the steps a run sends to the model,
// reading what the model sees for each, and the lineage of the stored verdicts. Only the model
// call itself is not SQL.

import { CompileError, sqlString } from '../search/compile.ts';
import type { Statement } from '../trajectory/query.ts';
import { sessionId } from '../trajectory/session.ts';
import { type Pick, type Reads, TURN_STEPS, wordsOf } from './judge.ts';

/** A judged step: its session and the sequence number of its model call. */
export interface StepRef { session_id: string; seq: number }
/**
 * Which steps a run judges: picked steps without a verdict of the run's version, steps without any
 * verdict, out-of-date verdicts (all, or the violating ones), or verdicts of the run's version whose
 * model call never reached the model.
 */
export type Scope = 'picked' | 'new' | 'stale' | 'stale-violating' | 'failed';
/** What a run needs of a judge version to choose its steps. */
export interface VersionRef { judge: string; version: number; pick: Pick }

/** Steps in a sample for a try (spec 8.7). */
export const SAMPLE = 5;
/** Characters of one block the model reads. */
export const BLOCK_CHARS = 2000;

const TARGET = "lower(coalesce(c.resource, CAST(c.args AS STRING), ''))";

function callConditions(pick: Pick): string[] {
  const tool = pick.tool === 'any' ? [] : pick.tool === 'change' ? ["c.name IN ('Edit', 'Write')"] : [`c.name = ${sqlString(pick.tool)}`];
  const status = pick.status === 'any' ? [] : [`c.status = ${sqlString(pick.status)}`];
  return ["c.kind = 'tool_call'", ...tool, ...status];
}

/** The steps a judge picks: model calls that made at least one tool call meeting the pick, named `picked`. */
export function pickedCte(db: string, pick: Pick): string {
  const words = wordsOf(pick.has);
  const has = words.length ? [`    AND (${words.map((w) => `instr(${TARGET}, ${sqlString(w)}) > 0`).join(' OR ')})`] : [];
  return [
    'picked AS (',
    '  SELECT c.session_id, c.parent_seq AS seq, min(s.ts) AS ts, min(s.turn) AS turn, min(s.step) AS step',
    `  FROM ${db}.agent_events c`,
    `  JOIN ${db}.agent_events s ON s.session_id = c.session_id AND s.seq = c.parent_seq AND s.kind = 'llm_call'`,
    `  WHERE ${callConditions(pick).join(' AND ')}`,
    ...has,
    '  GROUP BY c.session_id, c.parent_seq',
    ')',
  ].join('\n');
}

/** How many steps and sessions a pick finds. */
export const countSql = (db: string, pick: Pick): Statement => ({
  title: 'Steps to judge',
  sql: `WITH ${pickedCte(db, pick)}\nSELECT count(*) AS steps, count(DISTINCT session_id) AS sessions FROM picked`,
});

/** A few picked steps spread over all of them, newest first, for a try. */
export function sampleSql(db: string, pick: Pick): Statement {
  const at = Array.from({ length: SAMPLE }, (_, k) => (k === 0 ? '0' : k === 1 ? 'n DIV 5' : `(${k} * n) DIV 5`));
  return {
    title: 'Steps to try',
    sql: [
      `WITH ${pickedCte(db, pick)},`,
      'ranked AS (',
      '  SELECT p.*, row_number() OVER (ORDER BY p.ts DESC, p.session_id, p.seq) - 1 AS i, count(*) OVER () AS n',
      '  FROM picked p',
      ')',
      'SELECT session_id, seq, ts, turn, step FROM ranked',
      `WHERE n <= ${SAMPLE} OR i IN (${at.join(', ')})`,
      'ORDER BY i',
    ].join('\n'),
  };
}

/** The latest verdict of each step a judge has judged, and the version that made it, named `latest`. */
export const latestCte = (db: string, judge: string): string => [
  'latest AS (',
  '  SELECT session_id, seq, max(judge_version) AS made_by, max_by(verdict, judge_version) AS verdict',
  `  FROM ${db}.agent_judgments`,
  `  WHERE judge = ${sqlString(judge)}`,
  '  GROUP BY session_id, seq',
  ')',
].join('\n');

const version = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 1) throw new CompileError('version must be a whole number');
  return n;
};

/** The steps a run of one judge version sends to the model, oldest first. */
export function subjectsSql(db: string, v: VersionRef, scope: Scope): Statement {
  const judge = sqlString(v.judge);
  const head = `SELECT p.session_id, p.seq, p.ts, p.turn, p.step\nFROM picked p`;
  if (scope === 'picked' || scope === 'new') {
    const mine = scope === 'picked' ? ` AND judge_version = ${version(v.version)}` : '';
    return {
      title: 'Steps to judge',
      sql: [
        `WITH ${pickedCte(db, v.pick)}`,
        head,
        `LEFT JOIN (SELECT DISTINCT session_id, seq FROM ${db}.agent_judgments WHERE judge = ${judge}${mine}) d ON d.session_id = p.session_id AND d.seq = p.seq`,
        'WHERE d.seq IS NULL',
        'ORDER BY p.ts, p.session_id, p.seq',
      ].join('\n'),
    };
  }
  if (scope === 'failed') {
    return {
      title: 'Steps whose model call failed',
      sql: [
        `WITH ${pickedCte(db, v.pick)}`,
        head,
        `JOIN (SELECT DISTINCT session_id, seq FROM ${db}.agent_judgments WHERE judge = ${judge} AND judge_version = ${version(v.version)} AND verdict = 'unsure' AND input_tokens = 0) f ON f.session_id = p.session_id AND f.seq = p.seq`,
        'ORDER BY p.ts, p.session_id, p.seq',
      ].join('\n'),
    };
  }
  const violating = scope === 'stale-violating' ? " AND l.verdict = 'violates'" : '';
  return {
    title: 'Out-of-date verdicts',
    sql: [
      `WITH ${pickedCte(db, v.pick)},`,
      latestCte(db, v.judge),
      head,
      'JOIN latest l ON l.session_id = p.session_id AND l.seq = p.seq',
      `WHERE l.made_by < ${version(v.version)}${violating}`,
      'ORDER BY p.ts, p.session_id, p.seq',
    ].join('\n'),
  };
}

/**
 * How many steps a judge has judged, how many of their latest verdicts an older version than
 * `current` made, the input tokens a step has taken on average, to estimate a rerun, and how many
 * verdicts of `current` are unsure because the model call failed.
 */
export const lineageSql = (db: string, judge: string, current: number): Statement => ({
  title: 'Verdicts',
  sql: [
    `WITH ${latestCte(db, judge)},`,
    'spent AS (',
    `  SELECT round(avg(input_tokens)) AS per_step FROM ${db}.agent_judgments WHERE judge = ${sqlString(judge)} AND input_tokens > 0`,
    '),',
    'broken AS (',
    `  SELECT count(*) AS n FROM ${db}.agent_judgments WHERE judge = ${sqlString(judge)} AND judge_version = ${version(current)} AND verdict = 'unsure' AND input_tokens = 0`,
    ')',
    "SELECT count(*) AS judged, sum(if(verdict = 'violates', 1, 0)) AS violations,",
    "       count(DISTINCT if(verdict = 'violates', session_id, NULL)) AS sessions,",
    `       sum(if(made_by < ${version(current)}, 1, 0)) AS stale, sum(if(made_by < ${version(current)} AND verdict = 'violates', 1, 0)) AS stale_violating,`,
    '       max(spent.per_step) AS tokens_per_step, max(broken.n) AS failed',
    'FROM latest, spent, broken',
  ].join('\n'),
});

function near(reads: Reads): string {
  if (reads.kind === 'step') return 'e.step = j.step';
  return `e.step BETWEEN j.step - ${reads.kind === 'before' ? reads.n : TURN_STEPS} AND j.step`;
}

function stepCondition(steps: readonly StepRef[]): string {
  if (!steps.length) throw new CompileError('no step to read');
  return steps.map((s) => {
    if (!Number.isSafeInteger(s.seq)) throw new CompileError('seq must be a whole number');
    return `(j.session_id = ${sqlString(sessionId(s.session_id))} AND j.seq = ${s.seq})`;
  }).join(' OR ');
}

/**
 * What the model reads for each of some steps: the user's request of the turn, and the model calls
 * and tool calls near the judged one, each with its text, arguments and tool results. A text said
 * before is stored once under the first event that said it, so a block is also found by the
 * event's own `msg_seq` and `result_msg`.
 */
export function readsSql(db: string, reads: Reads, steps: readonly StepRef[]): Statement {
  return {
    title: 'What the model reads',
    sql: [
      'WITH judged AS (',
      '  SELECT j.session_id, j.seq, j.turn, j.step',
      `  FROM ${db}.agent_events j`,
      `  WHERE j.kind = 'llm_call' AND (${stepCondition(steps)})`,
      '),',
      'seen AS (',
      "  SELECT j.session_id, j.seq AS judged, e.seq, e.kind, e.step, e.name, e.status, coalesce(e.resource, CAST(e.args AS STRING), '') AS target,",
      '         e.msg_seq, e.result_msg, CAST(e.args AS STRING) AS args',
      '  FROM judged j',
      `  JOIN ${db}.agent_events e ON e.session_id = j.session_id AND e.turn = j.turn`,
      `  WHERE e.kind = 'user_input' OR (e.kind IN ('llm_call', 'tool_call') AND ${near(reads)})`,
      ')',
      `SELECT r.session_id, r.judged, r.seq, r.kind AS event_kind, r.step, r.name, r.status, left(r.target, ${BLOCK_CHARS}) AS target, left(r.args, ${BLOCK_CHARS}) AS args,`,
      `       m.msg_seq, m.kind, m.is_error, left(m.text, ${BLOCK_CHARS}) AS text`,
      'FROM seen r',
      `LEFT JOIN ${db}.agent_messages m ON m.session_id = r.session_id AND m.kind IN ('text', 'tool_result')`,
      '  AND (m.event_seq = r.seq OR m.msg_seq = r.msg_seq OR m.msg_seq = r.result_msg)',
      'ORDER BY r.session_id, r.judged, r.seq, m.msg_seq',
    ].join('\n'),
  };
}
