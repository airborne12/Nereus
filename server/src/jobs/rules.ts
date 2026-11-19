// The rules job (spec 6.5): runs the safety rules on the session trees that were imported since
// the rules last ran on them, and writes what they find to `agent_risks`. Doris says which trees
// are due: the main session's `safety_risks` is unset by an import and set by this job.

import type { Doris } from '../db/doris.ts';
import { batches, labelFor, type Load } from '../semantics/ingest/writer.ts';
import { sqlString } from '../semantics/search/compile.ts';
import { type Risk, risksOf, RULES, ruleSql } from '../semantics/sequences/rules.ts';
import { dorisTime } from '../semantics/trajectory/model.ts';
import type { Statement } from '../semantics/trajectory/query.ts';
import { sessionId } from '../semantics/trajectory/session.ts';
import type { LeaseStore } from './leases.ts';

export const RULES_JOB = 'rules';
/** How long a runner may take over one tree before another may take it. */
const LEASE_SECONDS = 300;
/** Trees one pass looks at. */
const PASS = 100;

export interface RulesDeps { doris: Doris; db: string; load: Load; leases: LeaseStore; now?: () => Date }
/** A tree whose run failed, and why. */
export interface Failed { root: string; error: string }
export interface RulesReport { trees: number; risks: number; held: number; failed: Failed[] }

/** The trees the rules have not run on since their last import, oldest activity first, but for those in `skip`. */
export function dueSql(db: string, limit: number, skip: readonly string[] = []): Statement {
  const left = skip.length ? ` AND session_id NOT IN (${skip.map(sqlString).join(', ')})` : '';
  return { title: 'Due', sql: `SELECT session_id FROM ${db}.agent_sessions\nWHERE kind = 'main' AND safety_risks IS NULL${left}\nORDER BY last_event_at, session_id\nLIMIT ${Math.trunc(limit)}` };
}

/** Makes every tree due, to run the rules again after their code changed. */
export const allDueSql = (db: string): string => `UPDATE ${db}.agent_sessions SET safety_risks = NULL WHERE kind = 'main'`;

/** Runs every rule on one tree and replaces its risks; answers how many it found. */
export async function runRulesOn(deps: RulesDeps, rootId: string): Promise<number> {
  const { doris, db } = deps;
  const root = sqlString(sessionId(rootId));
  const ids = (await doris.query(`SELECT session_id FROM ${db}.agent_sessions WHERE root_id = ${root}`)).map((r) => String(r.session_id));
  if (!ids.length) return 0;
  const foundAt = dorisTime((deps.now ?? (() => new Date()))().toISOString());
  const perRule = await Promise.all(RULES.map(async (rule) => risksOf(rule, await doris.query(ruleSql(db, rule, ids).sql), { rootId, foundAt })));
  const risks: Risk[] = perRule.flat();
  const list = ids.map((id) => sqlString(id)).join(', ');
  await doris.query(`DELETE FROM ${db}.agent_risks WHERE session_id IN (${list})`);
  const run = foundAt.replace(/\D/g, '');
  for (const [i, part] of batches(risks).entries()) await deps.load('agent_risks', labelFor('agent_risks', rootId, i, part, run), part);
  // The counts are written last: a run that stops before this leaves the tree due.
  await doris.query(countsSql(db, rootId, ids, risks));
  return risks.length;
}

/** Writes how many risks each session of a tree has; the main session counts the whole tree, as its other counts do. */
export function countsSql(db: string, rootId: string, ids: readonly string[], risks: readonly Pick<Risk, 'session_id'>[]): string {
  const own = (id: string) => risks.filter((r) => r.session_id === id).length;
  const counts = ids.map((id) => `WHEN ${sqlString(id)} THEN ${id === rootId ? risks.length : own(id)}`).join(' ');
  return `UPDATE ${db}.agent_sessions SET safety_risks = CASE session_id ${counts} ELSE 0 END WHERE session_id IN (${ids.map((id) => sqlString(id)).join(', ')})`;
}

/** Whether a tree is still due once its lease is taken: another runner may have run it since the list was read. */
async function stillDue(deps: RulesDeps, rootId: string): Promise<boolean> {
  const rows = await deps.doris.query(`SELECT session_id FROM ${deps.db}.agent_sessions WHERE session_id = ${sqlString(sessionId(rootId))} AND safety_risks IS NULL`);
  return rows.length > 0;
}

/** One pass over the trees that are due. A tree another runner holds is left to it. */
export async function runRules(deps: RulesDeps, skip: readonly string[] = []): Promise<RulesReport> {
  const due = (await deps.doris.query(dueSql(deps.db, PASS, skip).sql)).map((r) => String(r.session_id));
  let report: RulesReport = { trees: 0, risks: 0, held: 0, failed: [] };
  for (const rootId of due) {
    if (!(await deps.leases.take(RULES_JOB, rootId, LEASE_SECONDS))) {
      report = { ...report, held: report.held + 1 };
      continue;
    }
    try {
      if (await stillDue(deps, rootId)) {
        const found = await runRulesOn(deps, rootId);
        report = { ...report, trees: report.trees + 1, risks: report.risks + found };
      }
    } catch (e) {
      // The tree stays due; the pass goes on with the others.
      report = { ...report, failed: [...report.failed, { root: rootId, error: (e as Error).message }] };
    } finally {
      await deps.leases.release(RULES_JOB, rootId);
    }
  }
  return report;
}
