// Every statement of the agent API is planned by Doris on empty tables (spec 11): each page with
// every column as the sort and as a condition, the session page, Compare, the exports, the
// sequences and the safety rules.
// Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { dueSql } from '../src/jobs/rules.ts';
import { matchSql } from '../src/semantics/sequences/match.ts';
import { parsePattern } from '../src/semantics/sequences/pattern.ts';
import { pathsSql, toolsSql } from '../src/semantics/sequences/paths.ts';
import { risksPage, treeRisksSql } from '../src/semantics/sequences/risks.ts';
import { RULES, ruleSql } from '../src/semantics/sequences/rules.ts';
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
  for (const page of [sessionsPage(db), stepsPage(db), messagesPage(db), risksPage(db)]) await planned(pageStatements(page));
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

test('sequences: every shape of a step, every sort, and the drawing', { skip: !enabled }, async () => {
  const range = { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' };
  const patterns: unknown[][] = [
    [{ tool: 'Read' }],
    [{ tool: 'Edit' }, { tool: 'Bash', status: 'failed', has: 'test', link: 'next' }, { tool: 'Edit', same: 1, link: 'next' }],
    [{ tool: 'Grep' }, { tool: 'Read', link: 'later' }, { tool: 'Edit', same: 2, link: 'later' }, { tool: 'Bash', status: 'ok', any: ['test', 'check'], link: 'later' }],
    [{ kind: 'reply', has: 'should i' }, { kind: 'user', link: 'next' }, { kind: 'compaction', link: 'later' }, { link: 'next' }, { kind: 'user', same: 2, link: 'later' }, { kind: 'reply', link: 'later' }],
  ];
  const statements = patterns.flatMap((raw) => {
    const pattern = parsePattern(raw);
    const sorts = ['time', 'session', 'agent', 'turn', 'span', ...pattern.map((_, i) => `step${i + 1}`)];
    return sorts.flatMap((sort) => {
      const { rows, total } = matchSql(db, { ...range, pattern, sort, dir: 'asc', limit: 100, offset: 100 });
      return [rows, total];
    });
  });
  const drawings = [{ kind: 'failed' as const }, { kind: 'user' as const }, { kind: 'tool' as const, tool: 'Bash' }]
    .flatMap((start) => [2, 3, 4].map((depth) => pathsSql(db, { ...range, start, depth })));
  await planned([...statements, ...drawings, toolsSql(db, range.from, range.to)]);
});

test('safety rules: each rule over a tree, the trees that are due, the risks of a tree', { skip: !enabled }, async () => {
  await planned([...RULES.map((r) => ruleSql(db, r, ['m', 'agent-a1'])), dueSql(db, 100), treeRisksSql(db, 'm')]);
});
