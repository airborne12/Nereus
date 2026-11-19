// "What happens next": the statement that counts the runs of events after a kind of event, and
// the tree the drawing shows.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStart, pathsSql, pathTree, toolsSql, type PathRow } from '../src/semantics/sequences/paths.ts';

const RANGE = { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' };

test('where a drawing starts', () => {
  assert.deepEqual(parseStart(null), { kind: 'failed' });
  assert.deepEqual(parseStart('failed'), { kind: 'failed' });
  assert.deepEqual(parseStart('user'), { kind: 'user' });
  assert.deepEqual(parseStart('tool:Bash'), { kind: 'tool', tool: 'Bash' });
  assert.throws(() => parseStart('Bash'), /'start' must be failed, user or tool:<name>/);
  assert.throws(() => parseStart('tool:'), /'start' must be failed, user or tool:<name>/);
  assert.throws(() => parseStart(`tool:${'x'.repeat(257)}`), /'start' must be failed, user or tool:<name>/);
});

test('the runs are read with lead() and counted per level', () => {
  const s = pathsSql('otel', { ...RANGE, start: { kind: 'tool', tool: "Ba'sh" }, depth: 4 });
  assert.equal(s.title, 'Paths');
  assert.match(s.sql, /^WITH events AS \(/);
  assert.doesNotMatch(s.sql, /AS target|agent_messages/, 'the drawing reads no text');
  assert.match(s.sql, /coalesce\(lead\(k, 1\) OVER \(PARTITION BY session_id ORDER BY pos\), ''\) AS k2/);
  assert.match(s.sql, /coalesce\(lead\(k, 3\) OVER \(PARTITION BY session_id ORDER BY pos\), ''\) AS k4/);
  assert.ok(s.sql.includes(String.raw`WHERE kind = 'tool_call' AND what = 'Ba\'sh'`));
  assert.match(s.sql, /SELECT 2 AS level, k2, '' AS k3, '' AS k4, times,\n {9}row_number\(\) OVER \(ORDER BY times DESC, k2\) AS rk, count\(\*\) OVER \(\) AS siblings, sum\(times\) OVER \(\) AS parent_times/);
  assert.match(s.sql, /SELECT 4 AS level, k2, k3, k4, times,\n {9}row_number\(\) OVER \(PARTITION BY k2, k3 ORDER BY times DESC, k4\) AS rk/);
  assert.match(s.sql, /FROM runs WHERE k3 <> '' GROUP BY k2, k3, k4/);
  assert.match(s.sql, /WHERE r\.parent_times \* 50 >= t\.n AND \(r\.rk = 1 OR \(r\.rk <= 3 AND r\.times \* 50 >= t\.n\)\)\nORDER BY r\.level, r\.rk, r\.k2, r\.k3, r\.k4$/);
});

test('a failed call or a user input as the start, and fewer columns', () => {
  assert.match(pathsSql('otel', { ...RANGE, start: { kind: 'failed' }, depth: 2 }).sql, /WHERE kind = 'tool_call' AND status = 'error'\n/);
  const user = pathsSql('otel', { ...RANGE, start: { kind: 'user' }, depth: 2 }).sql;
  assert.match(user, /WHERE kind = 'user_input'\n/);
  assert.doesNotMatch(user, /AS k3|3 AS level/);
  assert.throws(() => pathsSql('otel', { ...RANGE, start: { kind: 'user' }, depth: 5 }), /'depth' must be an integer from 2 to 4/);
  assert.throws(() => pathsSql('otel', { ...RANGE, start: { kind: 'user' }, depth: 1 }), /'depth' must be an integer from 2 to 4/);
});

test('the tools of the range, most called first', () => {
  const s = toolsSql('otel', RANGE.from, RANGE.to);
  assert.equal(s.title, 'Tools');
  assert.match(s.sql, /SELECT name, count\(\*\) AS calls\nFROM otel\.agent_events\nWHERE kind = 'tool_call' AND ts >= .* AND ts < .*\nGROUP BY name\nORDER BY calls DESC, name\nLIMIT 200$/);
});

const row = (level: number, keys: string[], times: number, rk: number, siblings: number, parent_times: number): PathRow =>
  ({ level, k2: keys[0] ?? '', k3: keys[1] ?? '', k4: keys[2] ?? '', times, rk, siblings, parent_times, total: 100 });

test('the tree keeps the three commonest branches of a node and counts the rest as other', () => {
  const tree = pathTree([
    row(2, ['c:Edit'], 60, 1, 5, 100),
    row(2, ['f:Bash'], 30, 2, 5, 100),
    row(2, [''], 6, 3, 5, 100),
    // The fourth and fifth branches of the start (4 times in all) were left out by the statement.
    row(3, ['c:Edit', 'c:Bash'], 59, 1, 2, 60),
    // A branch under 2 % of all runs is not drawn on its own, though it is the commonest of its node.
    row(3, ['f:Bash', 'c:Read'], 1, 1, 30, 30),
    row(4, ['c:Edit', 'c:Bash', 'r:'], 59, 1, 1, 59),
    // Children of a branch that is not drawn are ignored.
    row(4, ['f:Bash', 'c:Read', 'u:'], 1, 1, 1, 1),
  ], 4);
  assert.deepEqual(tree, {
    total: 100,
    kids: [
      { key: 'c:Edit', times: 60, other: { count: 1, times: 1 }, kids: [
        { key: 'c:Bash', times: 59, other: null, kids: [{ key: 'r:', times: 59, other: null, kids: [] }] },
      ] },
      { key: 'f:Bash', times: 30, other: { count: 30, times: 30 }, kids: [] },
      { key: '', times: 6, other: null, kids: [] },
    ],
    other: { count: 2, times: 4 },
  });
});

test('no run at all is an empty tree', () => {
  assert.deepEqual(pathTree([], 4), { total: 0, kids: [], other: null });
});
