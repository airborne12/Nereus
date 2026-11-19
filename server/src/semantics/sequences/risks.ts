// The risks the safety rules found, as the pages read them (spec 7, 8.2, 8.3): the Risks table,
// and the risks of one session tree. A tree whose rules have not run since its last import has no
// count on its main session yet, and its stored risks are left out until they are written again.

import { sqlString } from '../search/compile.ts';
import type { ColumnKind, Page, PageColumn, Statement } from '../trajectory/query.ts';
import { sessionId } from '../trajectory/session.ts';

const col = (name: string, expr: string, kind: ColumnKind, extra: Partial<PageColumn> = {}): PageColumn => ({ name, expr, kind, ...extra });

/** Risks of one tree the session page reads; a tree with more says so. */
export const RISKS_LIMIT = 500;

/** A row is one risk, in the session or sub-agent session it happened in. */
export function risksPage(db: string): Page {
  return {
    name: 'risks',
    from: () => [
      `FROM ${db}.agent_risks r`,
      `JOIN ${db}.agent_sessions s ON s.session_id = r.session_id`,
      `JOIN ${db}.agent_sessions m ON m.session_id = r.root_id`,
    ],
    fixed: ['m.safety_risks IS NOT NULL'],
    time: 'r.ts',
    keys: ['session_id', 'rule', 'first_seq'],
    search: (t) => `(r.what MATCH_PHRASE ${sqlString(t)} OR r.rule_name MATCH_PHRASE ${sqlString(t)})`,
    defaultSort: 'ts',
    columns: [
      col('ts', 'r.ts', 'time'),
      col('session_id', 'r.session_id', 'text'),
      col('root_id', 'r.root_id', 'text'),
      col('title', 'm.title', 'text', { indexed: true }),
      col('agent', 'coalesce(s.agent_name, s.kind)', 'text'),
      col('turn', 'r.turn', 'number'),
      // No model has judged the risks yet; the judges of sub-project 3 fill this in.
      col('judgment', "'none'", 'text'),
      col('rule', 'r.rule', 'text'),
      col('rule_name', 'r.rule_name', 'text', { indexed: true }),
      col('what', 'r.what', 'text', { indexed: true, long: true }),
      col('why', 'r.why', 'text', { long: true }),
      col('first_seq', 'r.first_seq', 'number'),
      col('rule_version', 'r.rule_version', 'number'),
      col('found_at', 'r.found_at', 'time'),
    ],
  };
}

/** The risks of the tree the session `id` belongs to, in the order they happened. */
export function treeRisksSql(db: string, id: string): Statement {
  const root = `(SELECT root_id FROM ${db}.agent_sessions WHERE session_id = ${sqlString(sessionId(id))})`;
  return {
    title: 'Risks',
    sql: `SELECT r.session_id, r.rule, r.rule_name, r.first_seq, r.rule_version, r.ts, r.turn, r.events, r.steps, r.what, r.why, r.found_at
FROM ${db}.agent_risks r
JOIN ${db}.agent_sessions m ON m.session_id = r.root_id
WHERE r.root_id = ${root} AND m.safety_risks IS NOT NULL
ORDER BY r.ts, r.session_id, r.first_seq, r.rule
LIMIT ${RISKS_LIMIT + 1}`,
  };
}
