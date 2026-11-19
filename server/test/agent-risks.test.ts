// The statements that read risks: the Risks table and the risks of one session tree.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RISKS_LIMIT, risksPage, treeRisksSql } from '../src/semantics/sequences/risks.ts';
import { tableSql } from '../src/semantics/trajectory/query.ts';

test('risks are shown only of trees the rules have run on since their last import', () => {
  const page = risksPage('otel');
  assert.deepEqual(page.fixed, ['m.safety_risks IS NOT NULL']);
  assert.deepEqual([page.time, page.defaultSort, page.keys], ['r.ts', 'ts', ['session_id', 'rule', 'first_seq']]);
  assert.deepEqual(page.columns.map((c) => c.name), ['ts', 'session_id', 'root_id', 'title', 'agent', 'turn', 'judgment', 'rule', 'rule_name', 'what', 'why', 'first_seq', 'rule_version', 'found_at']);
  const { rows } = tableSql(page, { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z', q: '', conditions: [], limit: 100, offset: 0 }, 'list');
  assert.match(rows.sql, /'none' AS `judgment`/);
  assert.match(rows.sql, /left\(r\.what, 1000\) AS `what`/);
  assert.match(rows.sql, /WHERE m\.safety_risks IS NOT NULL\n {2}AND r\.ts >= .* AND r\.ts < .*\nORDER BY r\.ts DESC, r\.session_id, r\.rule, r\.first_seq\nLIMIT 100 OFFSET 0$/);
});

test('the risks of a tree, whichever of its sessions is asked for, in the order they happened', () => {
  const s = treeRisksSql('otel', 'agent-a1');
  assert.equal(s.title, 'Risks');
  assert.match(s.sql, /WHERE r\.root_id = \(SELECT root_id FROM otel\.agent_sessions WHERE session_id = 'agent-a1'\) AND m\.safety_risks IS NOT NULL\nORDER BY r\.ts, r\.session_id, r\.first_seq, r\.rule\nLIMIT 501$/);
  assert.equal(RISKS_LIMIT, 500);
  assert.throws(() => treeRisksSql('otel', "x' OR 1=1"), /bad session id/);
});
