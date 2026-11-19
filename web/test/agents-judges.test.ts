// The Judges pages as data: the state in the address, a draft and how it changes, what the model
// read as parts, and versions and verdicts in words.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JudgeTemplate } from '../src/api/judges.ts';
import {
  budgetNote, canRun, countKey, draftBody, draftFrom, editDraft, leftOver, parseJudgeState, parseRecord, runsOnText, serializeJudgeState, stepText, tryKey, verdictLabel, versionChange,
} from '../src/lib/agents/judges.ts';

const TEMPLATES: Record<string, JudgeTemplate> = {
  test: { name: 'Test changed to pass', pick: { tool: 'change', has: 'test', status: 'any' }, reads: { kind: 'before', n: 3 }, criterion: 'Is the test fitted?', model: 'claude-haiku-5-5' },
  confirm: { name: 'Irreversible command', pick: { tool: 'Bash', has: 'rm | drop table', status: 'any' }, reads: { kind: 'turn' }, criterion: 'Was it agreed?', model: 'claude-haiku-5-5' },
};

test('a judge page keeps its view and its open row in the address', () => {
  assert.deepEqual(parseJudgeState(''), { view: 'first', row: null });
  assert.deepEqual(parseJudgeState('?view=changed&row=s-1%3A21'), { view: 'changed', row: { session_id: 's-1', seq: 21 } });
  assert.deepEqual(parseJudgeState('?view=else&row=nonsense'), { view: 'first', row: null });
  assert.equal(serializeJudgeState({ view: 'first', row: null }), '');
  assert.equal(serializeJudgeState({ view: 'all', row: { session_id: 's-1', seq: 21 } }), '?view=all&row=s-1%3A21');
});

test('a draft starts from a template, and changing its criterion makes it one of your own', () => {
  const d = draftFrom('test', TEMPLATES);
  assert.deepEqual(d, { template: 'test', name: 'Test changed to pass', pick: TEMPLATES.test!.pick, reads: { kind: 'before', n: 3 }, criterion: 'Is the test fitted?', model: 'claude-haiku-5-5', runsOnNew: true });
  assert.equal(editDraft(d, 'criterion', 'Is it fitted, really?', TEMPLATES).template, 'own');
  assert.equal(editDraft(d, 'criterion', 'Is the test fitted?', TEMPLATES).template, 'test', 'the template text itself keeps the template');
  assert.deepEqual(editDraft(d, 'template', 'confirm', TEMPLATES).pick, TEMPLATES.confirm!.pick, 'another template replaces what it sets');
  assert.equal(editDraft(d, 'template', 'own', TEMPLATES).criterion, 'Is the test fitted?', 'choosing "own" keeps the text');
  assert.deepEqual(editDraft(d, 'n', '25', TEMPLATES).reads, { kind: 'before', n: 10 });
  assert.deepEqual(editDraft(d, 'n', 'x', TEMPLATES).reads, { kind: 'before', n: 1 });
  assert.deepEqual(editDraft(d, 'reads', 'turn', TEMPLATES).reads, { kind: 'turn', n: 3 }, 'the number is kept for when "before" comes back');
  assert.deepEqual(editDraft(d, 'tool', 'Bash', TEMPLATES).pick, { ...TEMPLATES.test!.pick, tool: 'Bash' });
  assert.equal(editDraft(d, 'runsOnNew', false, TEMPLATES).runsOnNew, false);
  assert.deepEqual(d.pick, TEMPLATES.test!.pick, 'the draft itself is not changed');
});

test('what is sent for a draft, and when it can run', () => {
  const d = draftFrom('confirm', TEMPLATES);
  assert.deepEqual(draftBody(d), { name: 'Irreversible command', pick: TEMPLATES.confirm!.pick, reads: { kind: 'turn' }, criterion: 'Was it agreed?', model: 'claude-haiku-5-5', runsOnNew: true });
  assert.deepEqual(draftBody(editDraft(d, 'reads', 'before', TEMPLATES)).reads, { kind: 'before', n: 3 });
  assert.equal(canRun(d, 12), true);
  assert.equal(canRun(d, 0), false);
  assert.equal(canRun({ ...d, name: ' ' }, 12), false);
  assert.equal(canRun({ ...d, criterion: '' }, 12), false);
});

test('what the model read, as the request, the steps left out and the steps', () => {
  const text = '<request>\nMake it pass\nplease\n</request>\n<omitted steps="4"/>\n<step>\nCalled Bash: pytest (failed)\nResult: FAILED\n</step>\n<step judged="true">\nCalled Edit: tests/a_test.py\nResult: ok\n</step>';
  assert.deepEqual(parseRecord(text), {
    request: 'Make it pass\nplease', omitted: 4,
    steps: [{ judged: false, lines: ['Called Bash: pytest (failed)', 'Result: FAILED'] }, { judged: true, lines: ['Called Edit: tests/a_test.py', 'Result: ok'] }],
  });
  assert.deepEqual(parseRecord('<step judged="true">\nAssistant: Done.\n</step>'), { request: null, omitted: 0, steps: [{ judged: true, lines: ['Assistant: Done.'] }] });
});

test('the record is shown as it was said: its escaped text is read back', () => {
  assert.deepEqual(parseRecord('<request>\nkeep &lt;b&gt; &amp;amp;\n</request>\n<step judged="true">\nCalled Edit: a.py\nArguments: {"new_string":"x &lt; 1 &amp;&amp; y"}\nResult: ok\n</step>'), {
    request: 'keep <b> &amp;', omitted: 0, steps: [{ judged: true, lines: ['Called Edit: a.py', 'Arguments: {"new_string":"x < 1 && y"}', 'Result: ok'] }],
  });
});

test('a run that stopped or failed before judging its steps leaves some to judge', () => {
  const run = (scope: string, status: string) => ({ scope, status }) as Parameters<typeof leftOver>[0];
  assert.deepEqual([run('picked', 'stopped'), run('new', 'failed'), run('picked', 'done'), run('stale', 'stopped'), run('picked', 'running')].map(leftOver), [true, true, false, false, false]);
  assert.equal(leftOver(undefined), false);
});

test('verdicts, versions, steps and schedules in words', () => {
  assert.deepEqual(['violates', 'ok', 'unsure', 'else'].map(verdictLabel), ['Violates', 'Does not violate', 'No verdict', 'No verdict']);
  const v1 = { criterion: 'a', model: 'claude-haiku-5-5' };
  assert.equal(versionChange(v1, { criterion: 'b', model: 'claude-haiku-5-5' }), 'criterion');
  assert.equal(versionChange(v1, { criterion: 'a', model: 'claude-sonnet-5-5' }), 'model claude-haiku-5-5 → claude-sonnet-5-5');
  assert.equal(versionChange(v1, { criterion: 'b', model: 'claude-sonnet-5-5' }), 'criterion, model claude-haiku-5-5 → claude-sonnet-5-5');
  assert.equal(stepText({ step: 10, calls: 'Edit tests/a_test.py' }), 'step 10 · Edit tests/a_test.py');
  assert.equal(stepText({ step: 3, calls: null }), 'step 3 · reply');
  assert.deepEqual([runsOnText(true), runsOnText(false)], ['new sessions too', 'once']);
});

test('a count answers the pick and the reads of a draft; a try also its criterion and model, but not its name or schedule', () => {
  const d = draftFrom('test', TEMPLATES);
  const with_ = (field: string, value: string | boolean) => editDraft(d, field, value, TEMPLATES);
  assert.equal(countKey(with_('criterion', 'Other?')), countKey(d));
  for (const [f, v] of [['has', 'spec'], ['n', '5'], ['reads', 'turn']] as const) assert.notEqual(countKey(with_(f, v)), countKey(d), f);
  for (const [f, v] of [['name', 'Mine'], ['runsOnNew', false]] as const) assert.equal(tryKey(with_(f, v)), tryKey(d), f);
  for (const [f, v] of [['criterion', 'Other?'], ['model', 'claude-sonnet-5-5'], ['tool', 'Bash'], ['reads', 'turn']] as const) assert.notEqual(tryKey(with_(f, v)), tryKey(d), f);
});

test('the run budget is stated when the estimate is over it', () => {
  assert.equal(budgetNote(1_000, 10, 2_000_000), null);
  assert.equal(budgetNote(5_000_000, 5_000, 2_000_000), "The run stops at its budget of 2,000,000 input tokens, after about 2,000 of 5,000 steps; the judge's page then offers to judge the rest.");
});
