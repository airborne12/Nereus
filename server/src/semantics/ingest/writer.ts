// Writes the rows of one normalised branch to the agent tables in batches. Each batch's label is
// derived from its content, so a re-import of unchanged rows is answered "already loaded" and a
// changed batch is loaded again; the unique keys make a replaced row harmless.

import type { LoadOutcome } from '../../db/stream-load.ts';
import { sha256 } from '../trajectory/hash.ts';
import type { Normalised } from '../trajectory/model.ts';

export type Load = (table: string, label: string, rows: readonly object[]) => Promise<LoadOutcome>;

export const MAX_ROWS = 5000;
export const MAX_BYTES = 64 * 1024 * 1024;

/** Consecutive groups of at most `maxRows` rows and about `maxBytes` of JSON lines; a larger row goes alone. */
export function batches<T extends object>(rows: readonly T[], maxRows = MAX_ROWS, maxBytes = MAX_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = Buffer.byteLength(JSON.stringify(r), 'utf8') + 1;
    if (cur.length > 0 && (cur.length >= maxRows || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function labelFor(table: string, sessionId: string, index: number, rows: readonly object[]): string {
  const digest = sha256(`${sessionId}\n${index}\n${rows.map((r) => JSON.stringify(r)).join('\n')}`).slice(0, 40);
  return `${table}_${digest}`;
}

export async function writeBranch(load: Load, n: Normalised): Promise<{ table: string; rows: number; loaded: number; skipped: number }[]> {
  const tables: [string, readonly object[]][] = [
    ['agent_prompts', n.prompts], ['agent_messages', n.messages], ['agent_events', n.events], ['agent_contexts', n.contexts],
  ];
  const report: { table: string; rows: number; loaded: number; skipped: number }[] = [];
  for (const [table, rows] of tables) {
    const parts = batches(rows);
    const outcomes: LoadOutcome[] = [];
    for (const [i, part] of parts.entries()) outcomes.push(await load(table, labelFor(table, n.session.id, i, part), part));
    report.push({ table, rows: rows.length, loaded: outcomes.filter((o) => o === 'loaded').length, skipped: outcomes.filter((o) => o === 'already-loaded').length });
  }
  return report;
}
