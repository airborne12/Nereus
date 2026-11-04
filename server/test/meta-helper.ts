// A throwaway PostgreSQL database per test file, migrated, dropped afterwards.
//   META_ADMIN_URL (default postgres://postgres@127.0.0.1:5732/postgres) must be allowed to CREATE DATABASE.

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/meta.ts';

export const pgEnabled = process.env.PG_TEST === '1' || process.env.DORIS_TEST === '1';
const adminUrl = process.env.META_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5732/postgres';

export async function freshMetaDb(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const name = `dorisstack_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  await migrate(pool);
  return {
    pool,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE ${name}`);
      await a.end();
    },
  };
}
