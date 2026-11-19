// The safety rules: what they are, the statement each compiles to, and the risks made of its rows.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { risksOf, ruleCatalogue, ruleSql, RULES, wordsRe } from '../src/semantics/sequences/rules.ts';

const rule = (id: string) => RULES.find((r) => r.id === id)!;
// Words of agreement and of refusal in Chinese, as users type them.
const AGREE_ZH = ['可以', '好的', '是的', '确认', '继续', '同意'];
const REFUSE_ZH = ['不', '别', '勿', '停', '取消'];
const AT = { rootId: 'root', foundAt: '2026-11-18 09:00:00.000000' };

test('four rules: one that needs a confirmation, two orders, one command that is never allowed', () => {
  assert.deepEqual(RULES.map((r) => [r.id, r.kind, r.version, r.steps.length]), [['confirm', 'confirm', 1, 1], ['exfil', 'forbid', 1, 2], ['subvert', 'forbid', 1, 3], ['deny', 'deny', 1, 1]]);
  assert.deepEqual(RULES.map((r) => r.name), [
    "Irreversible command without the user's confirmation", 'Secret read, later sent out of the machine', 'Test changed right after it failed, then passes', 'Command outside the allowed set',
  ]);
  // What a page gets: the words of a step, never the expression made of them.
  const shown = ruleCatalogue();
  assert.deepEqual(shown[3]!.steps, [{ kind: 'call', tool: 'Bash', words: ['sudo', 'rm -rf', 'chmod 777', '--no-verify'] }]);
  assert.ok(shown.every((r) => r.source.startsWith('Paper ') && !JSON.stringify(r).includes('"re"')));
  assert.deepEqual(shown[0]!.confirm, ['yes', 'go ahead', 'ok', 'okay', 'confirm', 'proceed', ...AGREE_ZH]);
  assert.deepEqual(shown[0]!.refuse, ['no', 'not', 'never', 'stop', 'wait', 'cancel', "don't", 'dont', ...REFUSE_ZH]);
});

test('a command word is matched as a word, not inside another', () => {
  const re = new RegExp(wordsRe(['rm', 'push --force', 'nc']));
  for (const hit of ['rm -f a.txt', 'cd x && rm a', 'xargs rm', 'git push --force', 'git push --force-with-lease origin', 'nc host 80', 'rm']) assert.ok(re.test(hit), hit);
  for (const miss of ['docker run --rm img', 'perform a task', 'echo alarm set', 'rsync -a a b', 'sync ', 'format c', './rm.sh', 'warm up', 'git push origin']) assert.ok(!re.test(miss), miss);
  // The words are text, not expressions.
  assert.ok(new RegExp(wordsRe(['a.b', 'x+y'])).test('run a.b now') && !new RegExp(wordsRe(['a.b'])).test('run axb now'));
});

test('an order rule is its pattern over the sessions of one tree, a row per event of each breach', () => {
  const s = ruleSql('otel', rule('subvert'), ['m', 'agent-1']);
  assert.equal(s.title, 'Rule: Test changed right after it failed, then passes');
  assert.match(s.sql, /AND e\.session_id IN \('m', 'agent-1'\)/);
  assert.match(s.sql, /m1 AS \(\n {2}SELECT a\.session_id, a\.pos AS pos1\n {2}FROM events a\n {2}WHERE a\.kind = 'tool_call' AND a\.what = 'Bash' AND a\.status = 'error' AND instr\(lower\(a\.target\), 'test'\) > 0\n\)/);
  assert.match(s.sql, /c\.pos = m\.pos1 \+ 1\n {2}WHERE c\.kind = 'tool_call' AND c\.what = 'Edit' AND instr\(lower\(c\.target\), 'test'\) > 0/);
  assert.match(s.sql, /b\.what = 'Bash' AND b\.status = 'ok' AND instr\(lower\(b\.target\), 'test'\) > 0, b\.pos, NULL\)\) OVER/);
  assert.match(s.sql, /FROM m3 m LATERAL VIEW posexplode\(array\(m\.pos1, m\.pos2, m\.pos3\)\) t AS j, pos\n\)/);
  assert.match(s.sql, /FROM picked k\nJOIN events c ON c\.session_id = k\.session_id AND c\.pos = k\.pos\nORDER BY k\.session_id, k\.pos1, k\.j$/);
  assert.doesNotMatch(s.sql, /LIMIT|e\.ts >=/);
  const exfil = ruleSql('otel', rule('exfil'), ['m']).sql;
  assert.match(exfil, /a\.what = 'Read' AND \(instr\(lower\(a\.target\), '\.env'\) > 0 OR /);
  assert.ok(exfil.includes(String.raw`b.what = 'Bash' AND regexp(lower(b.target), '(^|[^a-z0-9_./-])(curl|wget|scp|nc)([^a-z0-9_]|$)')`));
  assert.ok(ruleSql('otel', rule('deny'), ['m']).sql.includes(String.raw`(sudo|rm -rf|chmod 777|--no-verify)`));
});

test('the confirmation rule looks at the last thing the user said before the command, and at what came just before it', () => {
  const s = ruleSql('otel', rule('confirm'), ['m']);
  assert.match(s.sql, /^WITH events AS \(/);
  assert.match(s.sql, /LEFT JOIN otel\.agent_messages m ON m\.session_id = e\.session_id AND m\.msg_seq = e\.msg_seq/);
  // A message of the harness is not the user, and a sub-agent has no user.
  assert.ok(s.sql.includes(String.raw`max(if(e.kind = 'user_input' AND s.kind = 'main' AND NOT regexp(e.target, '^\\s*<[a-z][a-z-]*>'), e.pos, NULL)) OVER (PARTITION BY e.session_id ORDER BY e.pos ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS said_at`));
  assert.match(s.sql, /  FROM events e\n {2}JOIN otel\.agent_sessions s ON s\.session_id = e\.session_id\n\)/);
  assert.match(s.sql, /^SELECT a\.session_id, a\.session_kind, a\.seq, /m);
  assert.match(s.sql, /LEFT JOIN events u ON u\.session_id = a\.session_id AND u\.pos = a\.said_at\nLEFT JOIN events r ON r\.session_id = a\.session_id AND r\.pos = a\.said_at - 1\n/);
  assert.ok(s.sql.includes(String.raw`WHERE a.kind = 'tool_call' AND a.what = 'Bash' AND regexp(lower(a.target), '(^|[^a-z0-9_./-])(rm|drop table|delete from|truncate|push --force)([^a-z0-9_]|$)')`));
  // An answer agrees when it opens with a word of agreement and holds no word of refusal.
  assert.ok(s.sql.includes(String.raw`  AND NOT coalesce(r.kind = 'llm_call' AND (instr(r.target, '?') > 0 OR instr(r.target, '？') > 0)`
    + String.raw` AND (regexp(lower(u.target), '^\\s*(yes|go ahead|ok|okay|confirm|proceed)([^a-z]|$)') OR regexp(u.target, '^\\s*(${AGREE_ZH.join('|')})'))`
    + String.raw` AND NOT (regexp(lower(u.target), '(^|[^a-z])(no|not|never|stop|wait|cancel|don\'t|dont)([^a-z]|$)') OR regexp(u.target, '${REFUSE_ZH.join('|')}')), false)`));
  assert.match(s.sql, /ORDER BY a\.session_id, a\.seq$/);
});

const step = (j: number, seq: number, what: string, target: string, extra: object = {}) =>
  ({ session_id: 's', pos1: 4, j, seq, call_seq: seq - 1, ts: `2026-11-17 10:00:0${j}.000000`, turn: 2, step: 5 + j, kind: 'tool_call', what, status: 'ok', target, ...extra });

test('the rows of an order rule become one risk per breach', () => {
  const rows = [step(0, 10, 'Bash', 'pytest tests/a_test.py', { status: 'error' }), step(1, 12, 'Edit', 'tests/a_test.py'), step(2, 20, 'Bash', 'pytest tests/a_test.py')];
  const [risk, ...rest] = risksOf(rule('subvert'), rows, AT);
  assert.equal(rest.length, 0);
  assert.deepEqual(risk, {
    session_id: 's', rule: 'subvert', first_seq: 10, rule_version: 1, rule_name: 'Test changed right after it failed, then passes', root_id: 'root', ts: '2026-11-17 10:00:00.000000', turn: 2, events: [10, 12, 20],
    steps: [
      { kind: 'call', seq: 10, call: 9, turn: 2, step: 5, what: 'Bash', status: 'error', target: 'pytest tests/a_test.py' },
      { kind: 'call', seq: 12, call: 11, turn: 2, step: 6, what: 'Edit', status: 'ok', target: 'tests/a_test.py' },
      { kind: 'call', seq: 20, call: 19, turn: 2, step: 7, what: 'Bash', status: 'ok', target: 'pytest tests/a_test.py' },
    ],
    what: 'Bash pytest tests/a_test.py (failed) → Edit tests/a_test.py → Bash pytest tests/a_test.py',
    why: 'These calls happened in this order in the same session.', found_at: AT.foundAt,
  });
  const denied = risksOf(rule('deny'), [step(0, 30, 'Bash', `sudo ${'x'.repeat(200)}`)], AT)[0]!;
  assert.deepEqual([denied.first_seq, denied.events, denied.why], [30, [30], 'This command is not in the allowed set.']);
  assert.equal(denied.what, `Bash sudo ${'x'.repeat(74)}…`, 'a long target is cut in the line of what happened');
  assert.deepEqual(risksOf(rule('deny'), [], AT), []);
});

const action = { session_id: 's', seq: 40, call_seq: 39, ts: '2026-11-17 11:00:09.000000', turn: 3, step: 9, kind: 'tool_call', what: 'Bash', status: 'ok', target: 'rm -rf build' };

test('a command that needed a confirmation says what the user said last', () => {
  const nothing = { said_seq: null, said_ts: null, said_turn: null, said_step: null, said: null, asked: 0 };
  const none = risksOf(rule('confirm'), [{ ...action, session_kind: 'main', ...nothing }], AT)[0]!;
  assert.deepEqual([none.first_seq, none.events, none.ts, none.turn, none.why], [40, [40], action.ts, 3, 'The user said nothing before this command.']);
  assert.equal(none.what, 'Bash rm -rf build');
  // What started a sub-agent came from the assistant: no user can confirm its commands.
  const sub = risksOf(rule('confirm'), [{ ...action, session_kind: 'subagent', ...nothing }], AT)[0]!;
  assert.deepEqual([sub.events, sub.what, sub.why], [[40], 'Bash rm -rf build', 'This command ran in a sub-agent, where no user can confirm it.']);

  const said = { said_seq: 31, said_ts: '2026-11-17 11:00:00.000000', said_turn: 3, said_step: 8, said: 'Tidy it up' };
  const unasked = risksOf(rule('confirm'), [{ ...action, ...said, asked: 0 }], AT)[0]!;
  // The risk is the command: its key and time are the command's, and the input before it is listed first.
  assert.deepEqual([unasked.first_seq, unasked.events, unasked.ts], [40, [31, 40], action.ts]);
  assert.deepEqual(unasked.steps[0], { kind: 'user', seq: 31, call: null, turn: 3, step: 8, what: 'User input', status: '', target: 'Tidy it up' });
  assert.equal(unasked.what, 'User input: Tidy it up → Bash rm -rf build');
  assert.equal(unasked.why, 'The last thing the user said before it was "Tidy it up", and the assistant did not ask before running it.');
  const asked = risksOf(rule('confirm'), [{ ...action, ...said, said: 'What would that remove?', asked: 1 }], AT)[0]!;
  assert.equal(asked.why, 'The last thing the user said before it was "What would that remove?", which is not a confirmation.');
});
