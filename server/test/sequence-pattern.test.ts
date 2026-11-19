// A sequence pattern as it arrives in a request: what is accepted, and what is refused before any SQL.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_STEPS, parsePattern } from '../src/semantics/sequences/pattern.ts';

test('the three patterns of the paper are accepted as written', () => {
  assert.deepEqual(parsePattern([{ tool: 'Edit' }, { tool: 'Bash', status: 'failed', has: 'test', link: 'next' }, { tool: 'Edit', same: 1, link: 'next' }]), [
    { kind: 'call', tool: 'Edit' },
    { kind: 'call', tool: 'Bash', status: 'failed', has: 'test', link: 'next' },
    { kind: 'call', tool: 'Edit', same: 1, link: 'next' },
  ]);
  assert.deepEqual(parsePattern([{ kind: 'reply', has: 'Should I' }, { kind: 'user', link: 'next' }, { tool: 'Bash', link: 'later' }]), [
    { kind: 'reply', has: 'should i' },
    { kind: 'user', link: 'next' },
    { kind: 'call', tool: 'Bash', link: 'later' },
  ]);
});

test('a step is a tool call unless it says otherwise, and empty conditions are dropped', () => {
  assert.deepEqual(parsePattern([{ tool: '', status: '', has: '  ' }]), [{ kind: 'call' }]);
  assert.deepEqual(parsePattern([{ kind: 'compaction' }]), [{ kind: 'compaction' }]);
  assert.deepEqual(parsePattern([{ tool: 'Bash', any: ['RM -rf', ' drop table '] }]), [{ kind: 'call', tool: 'Bash', any: ['rm -rf', 'drop table'] }]);
});

test('a pattern has one to six steps', () => {
  assert.throws(() => parsePattern([]), /1 to 6 steps/);
  assert.throws(() => parsePattern('x'), /1 to 6 steps/);
  const many = [{ tool: 'Read' }, ...Array.from({ length: MAX_STEPS }, () => ({ tool: 'Read', link: 'next' }))];
  assert.throws(() => parsePattern(many), /1 to 6 steps/);
  assert.equal(parsePattern(many.slice(0, MAX_STEPS)).length, MAX_STEPS);
});

test('how a step follows the one before it', () => {
  assert.throws(() => parsePattern([{ tool: 'Read' }, { tool: 'Edit' }]), /step 2: 'link' must be next or later/);
  assert.throws(() => parsePattern([{ tool: 'Read' }, { tool: 'Edit', link: 'soon' }]), /step 2: 'link' must be next or later/);
  assert.throws(() => parsePattern([{ tool: 'Read', link: 'next' }]), /step 1: the first step follows nothing/);
});

test('conditions a kind of event cannot have', () => {
  assert.throws(() => parsePattern([{ kind: 'jump' }]), /step 1: unknown event 'jump'/);
  assert.throws(() => parsePattern([{ kind: 'user', tool: 'Bash' }]), /step 1: only a tool call has a tool/);
  assert.throws(() => parsePattern([{ kind: 'reply', status: 'ok' }]), /step 1: only a tool call has a status/);
  assert.throws(() => parsePattern([{ tool: 'Bash', status: 'done' }]), /step 1: 'status' must be ok or failed/);
  assert.throws(() => parsePattern([{ kind: 'compaction', has: 'x' }]), /step 1: a compaction has no text/);
  assert.throws(() => parsePattern([{ tool: 'Bash', colour: 'red' }]), /step 1: unknown condition 'colour'/);
  assert.throws(() => parsePattern([null]), /step 1: must be an object/);
});

test('the same target as an earlier step', () => {
  assert.throws(() => parsePattern([{ tool: 'Edit', same: 1 }]), /step 1: 'same' must name an earlier step/);
  assert.throws(() => parsePattern([{ tool: 'Edit' }, { tool: 'Edit', same: 2, link: 'next' }]), /step 2: 'same' must name an earlier step/);
  assert.throws(() => parsePattern([{ tool: 'Edit' }, { tool: 'Edit', same: 1.5, link: 'next' }]), /step 2: 'same' must name an earlier step/);
  assert.throws(() => parsePattern([{ kind: 'compaction' }, { tool: 'Edit', same: 1, link: 'next' }]), /step 2: step 1 is a compaction and has no text/);
  assert.deepEqual(parsePattern([{ tool: 'Edit' }, { tool: 'Edit', same: 0, link: 'next' }])[1], { kind: 'call', tool: 'Edit', link: 'next' });
});

test('text conditions are bounded', () => {
  assert.throws(() => parsePattern([{ tool: 'x'.repeat(257) }]), /step 1: 'tool' is longer than 256 characters/);
  assert.throws(() => parsePattern([{ tool: 'Bash', has: 'x'.repeat(201) }]), /step 1: 'has' is longer than 200 characters/);
  assert.throws(() => parsePattern([{ tool: 'Bash', has: 7 }]), /step 1: 'has' must be text/);
  assert.throws(() => parsePattern([{ tool: 'Bash', any: 'rm' }]), /step 1: 'any' must be a list of at most 20 words/);
  assert.throws(() => parsePattern([{ tool: 'Bash', any: Array.from({ length: 21 }, () => 'x') }]), /step 1: 'any' must be a list of at most 20 words/);
});
