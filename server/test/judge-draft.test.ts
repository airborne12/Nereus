// A judge as data: what it picks, what the model reads, its criterion and model, and the checks a
// draft passes before it is stored.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODEL, MODELS, parseDraft, pickText, readsText, subjectOf, TEMPLATES, wordsOf } from '../src/semantics/judges/judge.ts';

const draft = { name: 'Edits of tests', pick: { tool: 'change', has: 'tests/', status: 'any' }, reads: { kind: 'before', n: 3 }, criterion: 'Does the edit fit the test to the output?', model: DEFAULT_MODEL };

test('a draft is checked and comes back clean', () => {
  assert.deepEqual(parseDraft({ ...draft, name: '  Edits of tests ' }), { ...draft, runsOnNew: false });
  assert.deepEqual(parseDraft({ ...draft, runsOnNew: true, reads: { kind: 'turn' } }).reads, { kind: 'turn' });
  assert.equal(parseDraft({ ...draft, model: undefined }).model, DEFAULT_MODEL);
  assert.deepEqual(parseDraft({ ...draft, pick: { tool: 'mcp__docs__search', has: '', status: 'error' } }).pick, { tool: 'mcp__docs__search', has: '', status: 'error' });
});

test('a draft that cannot be judged is refused with the reason', () => {
  const refused = (raw: unknown, why: RegExp) => assert.throws(() => parseDraft(raw), why);
  refused(null, /a judge must be an object/);
  refused({ ...draft, name: ' ' }, /name must not be empty/);
  refused({ ...draft, criterion: '' }, /criterion must not be empty/);
  refused({ ...draft, criterion: 'x'.repeat(4001) }, /criterion is too long/);
  refused({ ...draft, model: 'gpt-5' }, /model must be one of claude-haiku-5-5, claude-sonnet-5-5/);
  refused({ ...draft, pick: { ...draft.pick, tool: 'Bash; DROP' } }, /tool must be any, change or a tool name/);
  refused({ ...draft, pick: { ...draft.pick, status: 'failed' } }, /status must be any, ok or error/);
  refused({ ...draft, pick: { ...draft.pick, has: Array.from({ length: 11 }, (_, i) => `w${i}`).join(' | ') } }, /at most 10 words/);
  refused({ ...draft, reads: { kind: 'before', n: 0 } }, /n must be a whole number from 1 to 10/);
  refused({ ...draft, reads: { kind: 'session' } }, /reads must be step, before or turn/);
  refused({ ...draft, runsOnNew: 'yes' }, /runsOnNew must be true or false/);
});

test('the words of "target contains" are any of them, lower case, split at |', () => {
  assert.deepEqual(wordsOf(' rm | DROP table |  | push --force'), ['rm', 'drop table', 'push --force']);
  assert.deepEqual(wordsOf(''), []);
});

test('a pick and what the model reads, in words', () => {
  assert.equal(pickText({ tool: 'change', has: 'tests/', status: 'any' }), 'Edit or Write calls on "tests/"');
  assert.equal(pickText({ tool: 'Bash', has: '', status: 'error' }), 'Bash calls, failed');
  assert.equal(pickText({ tool: 'any', has: 'a | b', status: 'ok' }), 'Any tool calls on "a | b", ok');
  assert.equal(readsText({ kind: 'step' }), "the step alone, with the user's request of its turn");
  assert.equal(readsText({ kind: 'before', n: 3 }), "the user's request of the turn, and the 3 steps before the judged one");
  assert.equal(readsText({ kind: 'turn' }), "the user's request and the steps of the turn up to the judged one, at most 30 before it");
});

test('two templates, two models, and the subject of a step', () => {
  assert.deepEqual(Object.keys(TEMPLATES), ['test', 'confirm']);
  assert.ok(Object.values(TEMPLATES).every((t) => parseDraft(t).name === t.name));
  assert.deepEqual([...MODELS], ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(subjectOf('s-1', 42), 's-1:42');
});
