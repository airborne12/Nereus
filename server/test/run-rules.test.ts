// The command that runs the rules: passes go on until one finds nothing to run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runUntilDone } from '../src/cli/run-rules.ts';
import type { RulesReport } from '../src/jobs/rules.ts';

test('passes go on until one runs nothing; a tree that failed is named and left out of later passes', async () => {
  const answers: RulesReport[] = [
    { trees: 2, risks: 3, held: 0, failed: [{ root: 'x', error: 'boom' }] },
    { trees: 0, risks: 0, held: 1, failed: [{ root: 'y', error: 'bang' }] },
    { trees: 0, risks: 0, held: 1, failed: [] },
  ];
  const skips: string[][] = [];
  const total = await runUntilDone(async (skip) => {
    skips.push([...skip]);
    return answers[skips.length - 1]!;
  });
  assert.deepEqual(skips, [[], ['x'], ['x', 'y']]);
  assert.deepEqual(total, { trees: 2, risks: 3, held: 1, failed: [{ root: 'x', error: 'boom' }, { root: 'y', error: 'bang' }] });
});
