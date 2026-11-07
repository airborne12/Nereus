// Metadata store (PostgreSQL): connection pool and schema migrations.

import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export function metaPoolFromEnv(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const url = env.META_DATABASE_URL;
  if (!url) throw new Error('META_DATABASE_URL is not set (e.g. postgres://user:pass@127.0.0.1:5432/nereus)');
  return new pg.Pool({ connectionString: url, max: Number(env.META_POOL_SIZE ?? 10) });
}

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/**
 * Apply migrations/NNN_*.sql in order, each once and in its own transaction. An advisory lock
 * keeps two starting servers from applying the same migration.
 */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(new URL(f, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
