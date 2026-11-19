// The statements of the Judges pages (spec 8.7): the counts of every judge for the list, and the
// verdicts of one judge in the three views of its page, each row with the judged step.

import { CompileError, sqlString } from '../search/compile.ts';
import type { Statement } from '../trajectory/query.ts';
import { sessionId } from '../trajectory/session.ts';

export type View = 'first' | 'all' | 'changed';
/** Rows a view answers at most. */
export const VIEW_LIMIT = 500;

const whole = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new CompileError(`${what} must be a whole number`);
  return n;
};

/** Each judge's steps judged, violations, sessions, out-of-date verdicts and last verdict; none for no judge. */
export function judgesSql(db: string, judges: readonly { id: string; currentVersion: number }[]): Statement | null {
  if (!judges.length) return null;
  const current = `CASE judge ${judges.map((j) => `WHEN ${sqlString(j.id)} THEN ${whole(j.currentVersion, 'version')}`).join(' ')} END`;
  return {
    title: 'Judges',
    sql: [
      'WITH latest AS (',
      '  SELECT judge, session_id, seq, max(judge_version) AS made_by, max_by(verdict, judge_version) AS verdict, max(judged_at) AS at',
      `  FROM ${db}.agent_judgments`,
      `  WHERE judge IN (${judges.map((j) => sqlString(j.id)).join(', ')})`,
      '  GROUP BY judge, session_id, seq',
      ')',
      "SELECT judge, count(*) AS judged, sum(if(verdict = 'violates', 1, 0)) AS violations,",
      "       count(DISTINCT if(verdict = 'violates', session_id, NULL)) AS sessions,",
      `       sum(if(made_by < ${current}, 1, 0)) AS stale, max(at) AS last_judged`,
      'FROM latest',
      'GROUP BY judge',
    ].join('\n'),
  };
}

const LATEST = (db: string, judge: string) => [
  'latest AS (',
  '  SELECT session_id, seq, max(judge_version) AS made_by, max_by(verdict, judge_version) AS verdict, max_by(reason, judge_version) AS reason',
  `  FROM ${db}.agent_judgments`,
  `  WHERE judge = ${sqlString(judge)}`,
  '  GROUP BY session_id, seq',
  ')',
].join('\n');

/** The rows of a view before the step is joined: session_id, seq, made_by, verdict, reason, violations, was, was_version. */
function pickedOf(db: string, judge: string, view: View): string[] {
  if (view === 'all') return [`WITH ${LATEST(db, judge)},`, 'picked AS (', '  SELECT l.*, NULL AS violations, NULL AS was, NULL AS was_version FROM latest l', ')'];
  if (view === 'first') {
    return [
      `WITH ${LATEST(db, judge)},`,
      'marked AS (',
      '  SELECT l.session_id, l.seq, l.made_by, l.verdict, l.reason,',
      '         row_number() OVER (PARTITION BY l.session_id ORDER BY l.seq) AS rn, count(*) OVER (PARTITION BY l.session_id) AS violations',
      '  FROM latest l',
      "  WHERE l.verdict = 'violates'",
      '),',
      'picked AS (',
      '  SELECT session_id, seq, made_by, verdict, reason, violations, NULL AS was, NULL AS was_version FROM marked WHERE rn = 1',
      ')',
    ];
  }
  return [
    'WITH marked AS (',
    '  SELECT session_id, seq, judge_version, verdict, reason,',
    '         lag(verdict) OVER (PARTITION BY session_id, seq ORDER BY judge_version) AS was,',
    '         lag(judge_version) OVER (PARTITION BY session_id, seq ORDER BY judge_version) AS was_version,',
    '         row_number() OVER (PARTITION BY session_id, seq ORDER BY judge_version DESC) AS rn',
    `  FROM ${db}.agent_judgments`,
    `  WHERE judge = ${sqlString(judge)}`,
    '),',
    'picked AS (',
    '  SELECT session_id, seq, judge_version AS made_by, verdict, reason, NULL AS violations, was, was_version FROM marked WHERE rn = 1 AND was IS NOT NULL AND was <> verdict',
    ')',
  ];
}

const TITLES: Record<View, string> = { first: 'First violation in each session', all: 'All verdicts', changed: 'Changed by a rerun' };

/** The verdicts of a judge in one view, newest step first, each with the step, its session and its calls. */
export function verdictsSql(db: string, judge: string, current: number, view: View): Statement {
  return {
    title: TITLES[view],
    sql: [
      ...pickedOf(db, judge, view).slice(0, -1),
      '),',
      'tools_of AS (',
      "  SELECT c.session_id, c.parent_seq AS seq, group_concat(concat(c.name, ' ', left(coalesce(c.resource, CAST(c.args AS STRING), ''), 80)), ', ') AS calls",
      `  FROM ${db}.agent_events c`,
      '  JOIN picked p ON p.session_id = c.session_id AND p.seq = c.parent_seq',
      "  WHERE c.kind = 'tool_call'",
      '  GROUP BY c.session_id, c.parent_seq',
      ')',
      `SELECT e.ts, p.session_id, p.seq, e.turn, e.step, s.title, s.root_id, t.calls, p.verdict, p.made_by, p.made_by < ${whole(current, 'version')} AS stale, p.reason, p.violations, p.was, p.was_version`,
      'FROM picked p',
      `JOIN ${db}.agent_events e ON e.session_id = p.session_id AND e.seq = p.seq AND e.kind = 'llm_call'`,
      `LEFT JOIN ${db}.agent_sessions s ON s.session_id = p.session_id`,
      'LEFT JOIN tools_of t ON t.session_id = p.session_id AND t.seq = p.seq',
      'ORDER BY e.ts DESC, p.session_id, p.seq',
      // One row more than is shown, so that the page can say the view is cut.
      `LIMIT ${VIEW_LIMIT + 1}`,
    ].join('\n'),
  };
}

/** Every verdict a judge gave one step, newest version first. */
export const verdictSql = (db: string, judge: string, session: string, seq: number): Statement => ({
  title: 'Verdicts of the step',
  sql: `SELECT judge_version, verdict, reason, model, input_seqs, input_tokens, output_tokens, judged_at\nFROM ${db}.agent_judgments\nWHERE judge = ${sqlString(judge)} AND session_id = ${sqlString(sessionId(session))} AND seq = ${whole(seq, 'seq')}\nORDER BY judge_version DESC`,
});
