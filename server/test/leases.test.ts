// Leases in PostgreSQL: one holder at a time, and a lease whose time is up can be taken by another.
// Skipped unless PG_TEST=1 or DORIS_TEST=1.

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { Leases } from '../src/jobs/leases.ts';
import { freshMetaDb, pgEnabled } from './meta-helper.ts';

let pool: pg.Pool;
let drop: () => Promise<void> = async () => {};

before(async () => {
  if (!pgEnabled) return;
  const meta = await freshMetaDb();
  pool = meta.pool;
  drop = meta.drop;
});
after(async () => drop());

test('one holder at a time, and only the holder gives a lease back', { skip: !pgEnabled }, async () => {
  const a = new Leases(pool, 'a');
  const b = new Leases(pool, 'b');
  assert.equal(await a.take('rules', 't1', 60), true);
  assert.equal(await b.take('rules', 't1', 60), false);
  assert.equal(await a.take('rules', 't1', 60), true, 'the holder may take its lease again');
  await b.release('rules', 't1');
  assert.equal(await b.take('rules', 't1', 60), false, 'a release by another holder leaves the lease alone');
  await a.release('rules', 't1');
  assert.equal(await b.take('rules', 't1', 60), true);
});

test('a lease whose time is up can be taken by another holder', { skip: !pgEnabled }, async () => {
  const a = new Leases(pool, 'a');
  const b = new Leases(pool, 'b');
  assert.equal(await a.take('rules', 't2', 0), true);
  await sleep(20);
  assert.equal(await b.take('rules', 't2', 60), true);
  assert.equal(await a.take('rules', 't2', 60), false, 'the runner whose lease ran out has lost it');
});
