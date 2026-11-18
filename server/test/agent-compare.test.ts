// Compare: the statements, and the pairing of steps against an exhaustive search (spec 11).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { align, ALIGN_LIMIT, compareSql, matches, type StepFacts, turnSide } from '../src/semantics/trajectory/compare.ts';

const step = (tools: string, targets = '', failed = false): StepFacts => ({ seq: 0, step: 0, tools, targets, failed, ctx: 0 });

test('statements: both trees and their turns; the steps of a turn only when one is asked for', () => {
  assert.deepEqual(compareSql('otel', 'a', 'b', null).map((s) => s.title), ['Sessions', 'Turns']);
  const [, , steps] = compareSql('otel', 'a', 'b', 2);
  assert.match(steps!.sql, /e\.session_id IN \('a', 'b'\) AND e\.turn = 2 AND e\.kind IN \('llm_call', 'compaction'\)/);
  assert.match(steps!.sql, /coalesce\(e\.cache_write_tokens, 0\) AS ctx_tokens/);
  assert.throws(() => compareSql('otel', 'a', "b'", 1), /bad session id/);
});

test('the turn of a comparison is a whole number from 0', () => {
  assert.throws(() => compareSql('otel', 'a', 'b', 1.5), /'turn'/);
  assert.throws(() => compareSql('otel', 'a', 'b', -1), /'turn'/);
});

test('identical turns pair one to one without differences', () => {
  const a = [step('Read', 'x'), step('Bash', 'pytest'), step('reply')];
  assert.deepEqual(align(a, a), [0, 1, 2].map((i) => ({ a: i, b: i, differs: false })));
});

test('an extra step on one side gets a row of its own; the steps after it still pair', () => {
  const a = [step('Read', 'x'), step('Bash', 't'), step('reply')];
  const b = [step('Read', 'x'), step('Edit', 'x'), step('Bash', 't'), step('reply')];
  assert.deepEqual(align(a, b), [
    { a: 0, b: 0, differs: false }, { a: null, b: 1, differs: true }, { a: 1, b: 2, differs: false }, { a: 2, b: 3, differs: false },
  ]);
});

test('the same call is preferred; a different outcome differs', () => {
  const a = [step('Read', 'a'), step('Read', 'b', true)];
  const b = [step('Read', 'b')];
  assert.deepEqual(align(a, b), [{ a: 0, b: null, differs: true }, { a: 1, b: 0, differs: true }]);
});

/** The best total score over every increasing matching, by trying them all. */
function brute(n: number, m: number, score: (i: number, j: number) => number): number {
  const go = (i: number, j: number): number => {
    if (i >= n || j >= m) return 0;
    const s = score(i, j);
    return Math.max(go(i + 1, j), go(i, j + 1), s ? s + go(i + 1, j + 1) : 0);
  };
  return go(0, 0);
}

test('matches reaches the best total score on 300 small random pairs of turns', () => {
  let seed = 7;
  const rand = (k: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let t = 0; t < 300; t += 1) {
    const n = rand(7);
    const m = rand(7);
    const a = Array.from({ length: n }, () => [rand(3), rand(2)]);
    const b = Array.from({ length: m }, () => [rand(3), rand(2)]);
    const score = (i: number, j: number) => (a[i]![0] !== b[j]![0] ? 0 : a[i]![1] === b[j]![1] ? 3 : 2);
    const got = matches(n, m, score);
    assert.ok(got.every(([i, j], k) => score(i, j) > 0 && (k === 0 || (i > got[k - 1]![0] && j > got[k - 1]![1]))));
    assert.equal(got.reduce((s, [i, j]) => s + score(i, j), 0), brute(n, m, score));
  }
});

test('turns too long to align are paired by position', () => {
  const n = Math.floor(Math.sqrt(ALIGN_LIMIT)) + 1;
  const a = Array.from({ length: n }, () => step('Read'));
  const b = Array.from({ length: n }, () => step('Bash'));
  const rows = align(a, b);
  assert.equal(rows.length, n);
  assert.deepEqual(rows[5], { a: 5, b: 5, differs: true });
});

test('one side of a pair of turns: its steps with their context, its compactions by the step they follow', () => {
  const row = (session_id: string, seq: number, kind: string, tools: string, targets: string, failed: number, ctx_tokens: number | null) =>
    ({ session_id, seq, step: 0, kind, tools, targets, failed, ctx_tokens });
  const rows = [
    row('a', 3, 'compaction', 'reply', '', 0, 0),
    row('a', 4, 'llm_call', 'Read', 'x.py', 0, 1200),
    row('b', 4, 'llm_call', 'Bash', 'ls', 1, null),
    row('a', 6, 'llm_call', 'reply', '', 0, 1500),
    row('a', 7, 'compaction', 'reply', '', 0, 0),
  ];
  assert.deepEqual(turnSide(rows, 'a'), {
    steps: [
      { seq: 4, step: 0, tools: 'Read', targets: 'x.py', failed: false, ctx: 1200 },
      { seq: 6, step: 0, tools: 'reply', targets: '', failed: false, ctx: 1500 },
    ],
    cuts: [{ seq: 3, after: -1 }, { seq: 7, after: 1 }],
  });
  assert.deepEqual(turnSide(rows, 'b'), { steps: [{ seq: 4, step: 0, tools: 'Bash', targets: 'ls', failed: true, ctx: 0 }], cuts: [] });
});
