// Runs the safety rules on the session trees that are due: those imported since the rules last
// ran on them. Writes the risks to agent_risks and their counts to agent_sessions.
//
//   node src/cli/run-rules.ts [--all]
//
// --all makes every tree due first, to run the rules again after their code changed. Doris is
// reached as the import command reaches it; the leases are kept in the metadata database
// (META_DATABASE_URL).

import { Doris, configFromEnv } from '../db/doris.ts';
import { metaPoolFromEnv, migrate } from '../db/meta.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../db/stream-load.ts';
import { Leases } from '../jobs/leases.ts';
import { runRules, type RulesReport } from '../jobs/rules.ts';

/** Passes until none finds a tree it can take; answers what all of them did. */
export async function runUntilDone(pass: () => Promise<RulesReport>): Promise<RulesReport> {
  let total: RulesReport = { trees: 0, risks: 0, held: 0 };
  for (;;) {
    const r = await pass();
    total = { trees: total.trees + r.trees, risks: total.risks + r.risks, held: r.held };
    if (r.trees === 0) return total;
  }
}

if (import.meta.main) {
  const all = process.argv.includes('--all');
  const db = process.env.DORIS_DB ?? 'otel';
  const doris = new Doris(configFromEnv());
  const pool = metaPoolFromEnv();
  try {
    await migrate(pool);
    if (all) await doris.query(`UPDATE ${db}.agent_sessions SET safety_risks = NULL WHERE kind = 'main'`);
    const cfg = streamLoadConfigFromEnv();
    const deps = { doris, db, load: (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r), leases: new Leases(pool) };
    const report = await runUntilDone(() => runRules(deps));
    console.log(`${report.trees} session tree(s), ${report.risks} risk(s)${report.held ? `; ${report.held} tree(s) held by another runner` : ''}`);
  } catch (e) {
    console.error(`run-rules failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await doris.close();
    await pool.end();
  }
}
