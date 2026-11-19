// Every statement of the agent API is planned by Doris on empty tables (spec 11): each page with
// every column as the sort and as a condition, the session page, Compare and the exports.
// Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { compareSql } from '../src/semantics/trajectory/compare.ts';
import { conversationSql } from '../src/semantics/trajectory/export.ts';
import { messagesPage, sessionsPage, stepsPage } from '../src/semantics/trajectory/pages.ts';
import { type Condition, type Page, type Statement, tableSql, type TableRequest } from '../src/semantics/trajectory/query.ts';
import { compactionSql, marksSql, stepSql, treeSql, treeStepsSql, turnSql, turnStepsSql, turnsSql } from '../src/semantics/trajectory/session.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_agent_sql_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let doris: Doris;

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
});
after(async () => {
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
});

const req = (extra: Partial<TableRequest> = {}): TableRequest =>
  ({ from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z', q: 'clock "public API"', conditions: [], limit: 100, offset: 0, ...extra });

async function planned(statements: readonly Statement[]): Promise<void> {
  for (const s of statements) {
    await assert.doesNotReject(doris.query(`EXPLAIN ${s.sql}`), `${s.title}:\n${s.sql}`);
  }
}

function pageStatements(page: Page): Statement[] {
  const value = (kind: string) => (kind === 'number' ? '1' : kind === 'time' ? '2026-11-17 10:00:00' : 'x');
  return page.columns.flatMap((c) => {
    const cond: Condition = { column: c.name, op: c.kind === 'text' ? 'contains' : 'gt', value: value(c.kind) };
    const list = tableSql(page, req({ sort: c.name, conditions: [cond] }), 'list');
    return [list.rows, list.total, tableSql(page, req({ sort: c.name, dir: 'asc' }), 'export', 10).rows];
  });
}

test('table pages: every column as sort and as condition', { skip: !enabled }, async () => {
  for (const page of [sessionsPage(db), stepsPage(db), messagesPage(db)]) await planned(pageStatements(page));
});

test('session page, compare and exports', { skip: !enabled }, async () => {
  const s = stepSql(db, 'm', 5, 100);
  const c = compactionSql(db, 'm', 12);
  const conv = conversationSql(db, req(), false);
  const peek = conversationSql(db, req(), true);
  await planned([
    treeSql(db, 'm'), turnsSql(db, ['m', 'a']), marksSql(db, ['m', 'a']), treeStepsSql(db, ['m', 'a']), turnStepsSql(db, 'm', 1, 100), turnSql(db, 'm', 1),
    s.event, s.input, s.output, s.prompt, c.event, c.blocks, ...compareSql(db, 'm', 'n', 1),
    conv.size, conv.parts, conv.blocks, peek.size, peek.parts, peek.blocks,
  ]);
});
