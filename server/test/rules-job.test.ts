// The rules job with stubs in place of Doris, the loader and the leases: which trees it takes,
// the order of what it writes, and what it leaves alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doris } from '../src/db/doris.ts';
import { allDueSql, countsSql, dueSql, runRules } from '../src/jobs/rules.ts';

test('the trees that are due are the main sessions without a count of risks', () => {
  assert.equal(dueSql('otel', 100).sql, "SELECT session_id FROM otel.agent_sessions\nWHERE kind = 'main' AND safety_risks IS NULL\nORDER BY last_event_at, session_id\nLIMIT 100");
  // Trees that failed in an earlier pass are left out.
  assert.equal(dueSql('otel', 100, ['x', 'y']).sql, "SELECT session_id FROM otel.agent_sessions\nWHERE kind = 'main' AND safety_risks IS NULL AND session_id NOT IN ('x', 'y')\nORDER BY last_event_at, session_id\nLIMIT 100");
  assert.equal(allDueSql('otel'), "UPDATE otel.agent_sessions SET safety_risks = NULL WHERE kind = 'main'");
});

test('the main session counts the risks of its whole tree, a sub-agent its own', () => {
  const sql = countsSql('otel', 'm', ['m', 'agent-1', 'agent-2'], [{ session_id: 'm' }, { session_id: 'agent-1' }, { session_id: 'agent-1' }]);
  assert.equal(sql, "UPDATE otel.agent_sessions SET safety_risks = CASE session_id WHEN 'm' THEN 3 WHEN 'agent-1' THEN 2 WHEN 'agent-2' THEN 0 ELSE 0 END WHERE session_id IN ('m', 'agent-1', 'agent-2')");
});

/** A Doris that knows two due trees; the deny rule finds one command in the first. `done`: trees another runner finished since. */
function stubs(o: { held?: string[]; failOn?: string; done?: string[] } = {}) {
  const log: string[] = [];
  const doris = {
    query: async (sql: string) => {
      if (o.failOn && sql.includes(o.failOn)) throw new Error('doris is away');
      const still = /^SELECT session_id FROM otel\.agent_sessions WHERE session_id = '(\w+)' AND safety_risks IS NULL$/.exec(sql);
      if (still) return o.done?.includes(still[1]!) ? [] : [{ session_id: still[1] }];
      if (sql.includes('safety_risks IS NULL')) return [{ session_id: 'a' }, { session_id: 'b' }];
      if (sql.startsWith('SELECT session_id FROM otel.agent_sessions WHERE root_id')) return sql.includes("'a'") ? [{ session_id: 'a' }, { session_id: 'agent-1' }] : [{ session_id: 'b' }];
      if (sql.startsWith('DELETE') || sql.startsWith('UPDATE')) { log.push(sql.slice(0, sql.indexOf(' ', 7) + 1).trim() + (sql.includes("'a'") ? ' a' : ' b')); return []; }
      // Only the deny rule of tree `a` answers a row.
      if (sql.includes('sudo') && sql.includes("IN ('a', 'agent-1')")) {
        return [{ session_id: 'agent-1', pos1: 2, j: 0, seq: 7, call_seq: 6, ts: '2026-11-17 10:00:00.000000', turn: 1, step: 1, kind: 'tool_call', what: 'Bash', status: 'ok', target: 'sudo make install' }];
      }
      return [];
    },
  } as unknown as Doris;
  const loads: { table: string; label: string; rows: readonly object[] }[] = [];
  const load = async (table: string, label: string, rows: readonly object[]) => { loads.push({ table, label, rows }); log.push(`load ${table}`); return 'loaded' as const; };
  const taken: string[] = [];
  const leases = {
    take: async (job: string, unit: string) => { if (o.held?.includes(unit)) return false; taken.push(`${job}:${unit}`); return true; },
    release: async (job: string, unit: string) => { log.push(`release ${job}:${unit}`); },
  };
  return { deps: { doris, db: 'otel', load, leases, now: () => new Date('2026-11-18T09:00:00Z') }, log, loads, taken };
}

test('a pass runs the rules on each due tree: old risks out, new ones in, the counts last', async () => {
  const s = stubs();
  assert.deepEqual(await runRules(s.deps), { trees: 2, risks: 1, held: 0, failed: [] });
  assert.deepEqual(s.taken, ['rules:a', 'rules:b']);
  assert.deepEqual(s.log, ['DELETE FROM a', 'load agent_risks', 'UPDATE otel.agent_sessions a', 'release rules:a', 'DELETE FROM b', 'UPDATE otel.agent_sessions b', 'release rules:b']);
  assert.equal(s.loads.length, 1, 'a tree without risks loads nothing');
  assert.deepEqual(s.loads[0]!.rows, [{
    session_id: 'agent-1', rule: 'deny', first_seq: 7, rule_version: 1, rule_name: 'Command outside the allowed set', root_id: 'a', ts: '2026-11-17 10:00:00.000000', turn: 1, events: [7],
    steps: [{ kind: 'call', seq: 7, call: 6, turn: 1, step: 1, what: 'Bash', status: 'ok', target: 'sudo make install' }],
    what: 'Bash sudo make install', why: 'This command is not in the allowed set.', found_at: '2026-11-18 09:00:00.000000',
  }]);
});

test('a tree another runner holds is left to it', async () => {
  const s = stubs({ held: ['a'] });
  assert.deepEqual(await runRules(s.deps), { trees: 1, risks: 0, held: 1, failed: [] });
  assert.deepEqual(s.log, ['DELETE FROM b', 'UPDATE otel.agent_sessions b', 'release rules:b']);
});

test('a tree another runner finished after this pass read the list is left alone', async () => {
  const s = stubs({ done: ['a'] });
  assert.deepEqual(await runRules(s.deps), { trees: 1, risks: 0, held: 0, failed: [] });
  assert.deepEqual(s.log, ['release rules:a', 'DELETE FROM b', 'UPDATE otel.agent_sessions b', 'release rules:b']);
});

test('a tree that fails is named, gives its lease back, stays due, and the pass goes on', async () => {
  const s = stubs({ failOn: "DELETE FROM otel.agent_risks WHERE session_id IN ('a'" });
  assert.deepEqual(await runRules(s.deps), { trees: 1, risks: 0, held: 0, failed: [{ root: 'a', error: 'doris is away' }] });
  // Nothing of tree a was loaded and no count was written, so a later run takes it again.
  assert.deepEqual(s.log, ['release rules:a', 'DELETE FROM b', 'UPDATE otel.agent_sessions b', 'release rules:b']);
});
