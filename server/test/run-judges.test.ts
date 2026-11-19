// The command that runs the judges: what it prints about the runs it took.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { riskBudget, summary } from '../src/cli/run-judges.ts';
import { RISK_BUDGET } from '../src/jobs/risk-judgments.ts';

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

test('the risks judged join the line, and a stop or a rule that failed gets its own', () => {
  assert.deepEqual(summary({ queued: 0, runs: [], risks: { judged: 7, stopped: true, held: 1, failed: [{ rule: 'deny', error: 'Doris is down' }] } }, 5_000), [
    '0 run(s), 0 step(s) judged; 7 risk(s) judged; 1 risk judge(s) left to another runner',
    'risk judgments stopped before going over their budget of 5000 input tokens',
    'risk judge of rule deny failed: Doris is down',
  ]);
  assert.deepEqual(summary({ queued: 0, runs: [], risks: { judged: 0, stopped: false, held: 0, failed: [] } }), ['0 run(s), 0 step(s) judged; 0 risk(s) judged']);
});

test('the budget of the risk pass comes from RISK_JUDGE_BUDGET, a whole number of input tokens', () => {
  assert.equal(riskBudget({}), RISK_BUDGET);
  assert.equal(riskBudget({ RISK_JUDGE_BUDGET: '0' }), 0);
  assert.equal(riskBudget({ RISK_JUDGE_BUDGET: '50000' }), 50_000);
  for (const bad of ['', 'lots', '-1', '1.5', '1e9']) assert.throws(() => riskBudget({ RISK_JUDGE_BUDGET: bad }), /RISK_JUDGE_BUDGET must be a whole number of input tokens/, bad);
});
