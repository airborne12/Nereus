// Runs the safety rules on the session trees that are due: those imported since the rules last
// ran on them. Writes the risks to agent_risks and their counts to agent_sessions.
//
//   node src/cli/run-rules.ts [--all]
//
// --all makes every tree due first, to run the rules again after their code changed. A tree that
// fails is named and stays due, the others still run, and the command exits with 1. Doris is
// reached as the import command reaches it; the leases are kept in the metadata database
// (META_DATABASE_URL).

import { Doris, configFromEnv } from '../db/doris.ts';
import { metaPoolFromEnv, migrate } from '../db/meta.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { Leases } from '../jobs/leases.ts';
import { allDueSql, runRules, type RulesReport } from '../jobs/rules.ts';

/**
 * Passes until one runs no tree and no tree fails; answers what all of them did. A tree that
 * failed is left out of the later passes, so the others are not kept waiting behind it.
 */
export async function runUntilDone(pass: (skip: readonly string[]) => Promise<RulesReport>): Promise<RulesReport> {
  let total: RulesReport = { trees: 0, risks: 0, held: 0, failed: [] };
  for (;;) {
    const r = await pass(total.failed.map((f) => f.root));
    total = { trees: total.trees + r.trees, risks: total.risks + r.risks, held: r.held, failed: [...total.failed, ...r.failed] };
    if (r.trees === 0 && r.failed.length === 0) return total;
  }
}

if (import.meta.main) {
  const all = process.argv.includes('--all');
  const db = process.env.DORIS_DB ?? 'otel';
  const doris = new Doris(configFromEnv());
  const pool = metaPoolFromEnv();
  try {
    await migrate(pool);
    if (all) await doris.query(allDueSql(db));
    const cfg = streamLoadConfigFromEnv();
    const deps = { doris, db, load: (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r), leases: new Leases(pool) };
    const report = await runUntilDone((skip) => runRules(deps, skip));
    console.log(`${report.trees} session tree(s), ${report.risks} risk(s)${report.held ? `; ${report.held} tree(s) held by another runner` : ''}`);
    for (const f of report.failed) console.error(`run-rules: session tree ${f.root} failed: ${f.error}`);
    if (report.failed.length) process.exitCode = 1;
  } catch (e) {
    console.error(`run-rules failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await doris.close();
    await pool.end();
  }
}
