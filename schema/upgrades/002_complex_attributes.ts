// Run with Node 24 after stopping all telemetry writers. Old tables remain as backups.
import { pathToFileURL } from 'node:url';
import { Doris, configFromEnv } from '../../server/src/db.ts';

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error('Invalid SQL identifier');
  return `\`${value}\``;
}

export async function migrateComplexTable(doris: Doris, db: string, table: string, columns: string[]): Promise<string | null> {
  const qualified = `${identifier(db)}.${identifier(table)}`;
  const [create] = await doris.query(`SHOW CREATE TABLE ${qualified}`);
  const originalDdl = String(create!['Create Table']);
  const physical = new Set(Array.from(originalDdl.matchAll(/^\s+`([^`]+)`\s+/gm), (m) => m[1]));
  const rows = (await doris.query(`DESC ${qualified}`) as { Field: string; Type: string }[]).filter((r) => physical.has(r.Field));
  const changed = columns.filter((name) => {
    const column = rows.find((r) => r.Field === name);
    if (!column) throw new Error(`Missing column ${table}.${name}`);
    if (/^variant/i.test(column.Type)) return false;
    if (!/^array<struct</i.test(column.Type)) throw new Error(`Unexpected type for ${table}.${name}: ${column.Type}`);
    return true;
  });
  if (!changed.length) return null;

  const backup = `${table}_before_complex_variant`;
  const target = `${identifier(db)}.${identifier(backup)}`;
  let ddl = originalDdl.replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE ${target}`);
  for (const name of changed) {
    const pattern = new RegExp(`^(\\s*\`${name}\`\\s+)array<[^\\n]+>(\\s+.*)$`, 'im');
    if (!pattern.test(ddl)) throw new Error(`Cannot locate column definition for ${table}.${name}`);
    ddl = ddl.replace(pattern, '$1VARIANT$2');
  }
  // CREATE fails if a backup already exists; never overwrite a previous attempt.
  await doris.query(ddl);
  const names = rows.map((r) => identifier(r.Field));
  const values = rows.map((r) => changed.includes(r.Field) ? `CAST(to_json(${identifier(r.Field)}) AS VARIANT)` : identifier(r.Field));
  await doris.query(`INSERT INTO ${target} (${names.join(', ')}) SELECT ${values.join(', ')} FROM ${qualified}`);
  const [counts] = await doris.query(`SELECT (SELECT count(*) FROM ${qualified}) AS original, (SELECT count(*) FROM ${target}) AS copied`);
  if (String(counts!.original) !== String(counts!.copied)) throw new Error(`Row count mismatch for ${table}; tables were not swapped`);
  await doris.query(`ALTER TABLE ${qualified} REPLACE WITH TABLE ${identifier(backup)} PROPERTIES('swap' = 'true')`);
  return `${db}.${backup}`;
}

export async function migrateComplexAttributes(doris: Doris, db: string): Promise<string[]> {
  const backups: string[] = [];
  for (const [table, columns] of [
    ['otel_traces', ['events', 'links']],
    ...['gauge', 'sum', 'histogram', 'exponential_histogram'].map((kind) => [`otel_metrics_${kind}`, ['exemplars']]),
  ] as [string, string[]][]) {
    const backup = await migrateComplexTable(doris, db, table, columns);
    if (backup) { backups.push(backup); console.log(`Migrated ${db}.${table}; backup: ${backup}`); }
  }
  return backups;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--writers-stopped')) {
    throw new Error('Stop all telemetry writers, then pass --writers-stopped. See schema/upgrades/README.md.');
  }
  const doris = new Doris(configFromEnv());
  try {
    await migrateComplexAttributes(doris, process.env.DORIS_DB ?? 'otel');
  } finally {
    await doris.close();
  }
}
