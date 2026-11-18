// How the agent pages write times, sizes and counts, and the keys of a selection (no browser).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, duration, fileSize, num, plainLine, plural, stamp, timeOf, tokens } from '../src/lib/agents/format.ts';
import { cutKey, parseSel, selKey, stepKey, turnKey } from '../src/lib/agents/select.ts';

test('times are written as YYYY-MM-DD HH:MM:SS in the local zone, at one width', () => {
  const ms = new Date(2026, 10, 7, 9, 5, 3).getTime();
  assert.equal(stamp(ms), '2026-11-07 09:05:03');
  assert.equal(clock(ms), '09:05:03');
  assert.equal(timeOf('2026-11-17 10:00:01.250000'), Date.UTC(2026, 10, 17, 10, 0, 1, 250));
  for (const none of [null, undefined, '', 'soon', 5]) assert.equal(timeOf(none), null);
});

test('tokens, durations, counts and file sizes', () => {
  assert.deepEqual([0, 950, 1000, 12_340, 962_272, 1_250_000].map(tokens), ['0', '950', '1k', '12.3k', '962.3k', '1.25M']);
  assert.deepEqual([0, 400_000, 59_940_000, 59_960_000, 200_000_000, 3_599_600_000, 3_900_000_000].map(duration),
    ['0.0s', '0.4s', '59.9s', '1m 0s', '3m 20s', '1h 0m', '1h 5m']);
  assert.deepEqual([plural(1, 'step'), plural(0, 'step'), plural(2712, 'step')], ['1 step', '0 steps', '2,712 steps']);
  assert.deepEqual([512, 2970, 1_258_291].map(fileSize), ['512 bytes', '2.9 KB', '1.2 MB']);
  assert.deepEqual([num('13'), num(7), num(null), num('x')], [13, 7, 0, 0]);
});

test('selection keys: a session id may hold colons', () => {
  assert.equal(turnKey('m', 2), 't:m:2');
  assert.deepEqual(parseSel(stepKey('a:b:c', 14)), { kind: 'step', sid: 'a:b:c', seq: 14 });
  assert.deepEqual(parseSel(cutKey('m', 12)), { kind: 'cut', sid: 'm', seq: 12 });
  assert.equal(selKey({ kind: 'turn', sid: 'm', turn: 0 }), 't:m:0');
  for (const bad of [null, '', 's:m', 'x:m:1', 's:m:1.5', 's::1', 's:m:-1']) assert.equal(parseSel(bad), null, String(bad));
});

test('the first line with words, without the tags a runtime wraps a command in', () => {
  assert.equal(plainLine('<command-name>/model</command-name>\n<command-args></command-args>'), '/model');
  assert.equal(plainLine('<system-reminder>\n\n  Fix   the test  \nmore'), 'Fix the test');
  assert.equal(plainLine('a < b and c > d'), 'a d');
  assert.equal(plainLine(''), '');
});
