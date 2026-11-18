// schema/apply.sh on a database from before the rum rename. Skipped unless DORIS_TEST=1; needs the
// mysql client.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Doris, configFromEnv } from '../src/db/doris.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_apply_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let doris: Doris;

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await doris.query(`CREATE TABLE ${db}.otel_sessions (session_id VARCHAR(64) NOT NULL) DUPLICATE KEY (session_id)
    DISTRIBUTED BY HASH (session_id) BUCKETS 1 PROPERTIES ("replication_num" = "1")`);
});
after(async () => {
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
});

test('apply.sh stops on a database whose browser sessions are not renamed yet', { skip: !enabled }, async () => {
  const env = process.env;
  const r = spawnSync(new URL('../../schema/apply.sh', import.meta.url).pathname,
    ['-h', env.DORIS_HOST ?? '127.0.0.1', '-P', env.DORIS_PORT ?? '9030', '-u', env.DORIS_USER ?? 'root', '-p', env.DORIS_PASSWORD ?? '', '-d', db],
    { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /003_rum_sessions\.sql/);
  const tables = (await doris.query(`SHOW TABLES FROM ${db}`)).map((x) => String(Object.values(x)[0]));
  assert.deepEqual(tables, ['otel_sessions']);
});
