// Applies one schema file to a scratch database, with the substitutions schema/apply.sh makes.

import { readFileSync } from 'node:fs';
import type { Doris } from '../src/db/doris.ts';

export async function applySchemaFile(doris: Doris, file: string, db: string): Promise<void> {
  const sql = readFileSync(new URL(`../../schema/${file}`, import.meta.url), 'utf8')
    .replaceAll('${DB}', db).replaceAll('${RETENTION_DAYS}', '30').replaceAll('${AGENT_RETENTION_DAYS}', '365')
    .replaceAll('${REPLICATION_NUM}', '1').replace(/^--.*$/gm, '');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await doris.query(stmt);
}
