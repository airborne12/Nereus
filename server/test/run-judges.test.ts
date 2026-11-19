// The command that runs the judges: what it prints about the runs it took.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summary } from '../src/cli/run-judges.ts';

test('one line for all runs, then one per run that did not finish', () => {
  assert.deepEqual(summary({ queued: 0, runs: [] }), ['0 run(s), 0 step(s) judged']);
  assert.deepEqual(summary({
    queued: 1,
    runs: [
      { run: 3, judge: 'edits-a1', status: 'done', judged: 12, error: null },
      { run: 4, judge: 'rm-b2', status: 'stopped', judged: 40, error: 'Stopped before going over the budget of 1000 input tokens: 40 of 90 steps judged.' },
      { run: 5, judge: 'rm-b2', status: 'failed', judged: 0, error: 'The model cannot be used: invalid x-api-key' },
    ],
  }), [
    '3 run(s), 52 step(s) judged; 1 run(s) queued for new sessions',
    'run 4 of judge rm-b2 stopped: Stopped before going over the budget of 1000 input tokens: 40 of 90 steps judged.',
    'run 5 of judge rm-b2 failed: The model cannot be used: invalid x-api-key',
  ]);
});
