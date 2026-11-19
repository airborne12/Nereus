// Risks on the pages as data: which risk an address names, the rows a risk marks, a judgment and
// a rule in words.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Risk, RuleInfo } from '../src/api/agents.ts';
import { openTarget, RISKS, SESSIONS, sessionUrl, shownColumns } from '../src/lib/agents/pages.ts';
import { judgmentLabel, riskAt, riskKey, riskMarks, riskRowKey, rulePicture, stepSaid } from '../src/lib/agents/risks.ts';

const risk = (rule: string, first: number | string, steps: Risk['steps'] = []): Risk =>
  ({ session_id: 'agent-h1', rule, rule_name: rule, first_seq: first as number, rule_version: 1, ts: '2026-11-17 10:00:00', turn: 2, events: steps.map((s) => s.seq), steps, what: '', why: '', found_at: '' });

test('a risk is named in the address by its session, rule and first event', () => {
  // Big numbers arrive as text.
  const risks = [risk('subvert', '10'), risk('confirm', 31), risk('deny', 31)];
  assert.deepEqual(risks.map(riskKey), ['agent-h1:subvert:10', 'agent-h1:confirm:31', 'agent-h1:deny:31']);
  assert.deepEqual([riskAt(risks, 'agent-h1:deny:31'), riskAt(risks, 'first'), riskAt(risks, null), riskAt(risks, 'agent-h1:deny:99'), riskAt([], 'first')], [2, 0, -1, -1, -1]);
});

test('a risk marks the turn of an input and the step of a call or a reply', () => {
  const marks = riskMarks(risk('confirm', 40, [
    { kind: 'user', seq: 31, call: null, turn: 3, step: 8, what: 'User input', status: '', target: 'Tidy it up' },
    { kind: 'call', seq: 40, call: 39, turn: 3, step: 9, what: 'Bash', status: 'ok', target: 'rm -rf build' },
    { kind: 'reply', seq: 44, call: null, turn: 3, step: 10, what: 'Reply', status: '', target: 'Done.' },
  ]));
  assert.deepEqual(marks, [
    { key: 't:agent-h1:3', sid: 'agent-h1', turn: 3, stepNo: null },
    { key: 's:agent-h1:39', sid: 'agent-h1', turn: 3, stepNo: 9 },
    { key: 's:agent-h1:44', sid: 'agent-h1', turn: 3, stepNo: 10 },
  ]);
});

test('the row a risk is shown at is the one of the event it is keyed by', () => {
  const said = { kind: 'user' as const, seq: 31, call: null, turn: 3, step: 8, what: 'User input', status: '', target: 'Tidy it up' };
  const ran = { kind: 'call' as const, seq: 40, call: 39, turn: 3, step: 9, what: 'Bash', status: 'ok', target: 'rm -rf build' };
  // A command that needed a confirmation is keyed by the command, not by the input listed before it.
  assert.equal(riskRowKey(risk('confirm', '40', [said, ran])), 's:agent-h1:39');
  assert.equal(riskRowKey(risk('subvert', 40, [ran, { ...ran, seq: 44, call: 43 }])), 's:agent-h1:39');
  // A risk whose key event is not among its steps is shown at its first step; one without steps at no row.
  assert.deepEqual([riskRowKey(risk('deny', 99, [said])), riskRowKey(risk('deny', 99))], ['t:agent-h1:3', null]);
});

test('a judgment in words; a risk no model has read is not judged yet', () => {
  assert.deepEqual(['breach', 'review', 'ok', 'none', undefined, 'else'].map(judgmentLabel), ['Breach', 'Needs review', 'Not a breach', 'Not judged yet', 'Not judged yet', 'Not judged yet']);
});

const RULES: RuleInfo[] = [
  { id: 'confirm', version: 1, kind: 'confirm', name: 'Irreversible', source: 'Paper 3.1.2', steps: [{ kind: 'call', tool: 'Bash', words: ['rm', 'drop table'] }], confirm: ['yes', 'ok'], refuse: ['no'] },
  { id: 'subvert', version: 1, kind: 'forbid', name: 'Test changed', source: 'Paper B.2', steps: [{ kind: 'call', tool: 'Bash', status: 'failed', has: 'test' }, { kind: 'call', tool: 'Edit', has: 'test', link: 'next' }, { kind: 'call', tool: 'Bash', status: 'ok', has: 'test', link: 'later' }] },
  { id: 'deny', version: 1, kind: 'deny', name: 'Outside', source: 'Paper B.2', steps: [{ kind: 'call', tool: 'Bash', words: ['sudo'] }] },
];

test('a step of a rule in words', () => {
  assert.deepEqual(RULES[1]!.steps.map(stepSaid), ['Bash failed · "test"', 'Edit · "test"', 'Bash ok · "test"']);
  assert.equal(stepSaid(RULES[0]!.steps[0]!), 'Bash · "rm" or "drop table"');
  assert.equal(stepSaid({ kind: 'call', tool: 'Read', any: ['.env', 'secret'] }), 'Read · ".env" or "secret"');
  assert.deepEqual([stepSaid({ kind: 'call' }), stepSaid({ kind: 'user', has: 'yes' })], ['Any tool', 'User input · "yes"']);
});

test('a rule drawn: what must come first in green, what is not allowed in red', () => {
  assert.deepEqual(rulePicture(RULES[0]!), {
    label: 'Must come first', tone: 'ok',
    parts: [
      { pill: 'Assistant asks (reply has "?")', tone: 'ok' }, { arrow: '→ next' },
      { pill: 'User confirms (opens with "yes", "ok"; none of "no")', tone: 'ok' }, { arrow: '⇢ later, no other user input between' },
      { pill: 'Bash · "rm" or "drop table"', tone: 'act' },
    ],
  });
  assert.deepEqual(rulePicture(RULES[1]!), {
    label: 'Not allowed in this order', tone: 'bad',
    parts: [{ pill: 'Bash failed · "test"', tone: 'pre' }, { arrow: '→ next' }, { pill: 'Edit · "test"', tone: 'pre' }, { arrow: '⇢ later' }, { pill: 'Bash ok · "test"', tone: 'act' }],
  });
  assert.deepEqual(rulePicture(RULES[2]!), { label: 'Not allowed', tone: 'bad', parts: [{ pill: 'Bash · "sudo"', tone: 'act' }] });
});

test('the Risks page and the Risks column of Sessions', () => {
  assert.deepEqual(shownColumns(RISKS, null), ['ts', 'title', 'turn', 'judgment', 'rule_name', 'what']);
  assert.deepEqual(RISKS.columns.filter((c) => !c.shown).map((c) => c.label), ['Agent', 'Why it counts']);
  assert.deepEqual(shownColumns(SESSIONS, null).slice(0, 5), ['last_event_at', 'title', 'tool_errors', 'safety_risks', 'first_input']);
  // A row of Risks opens its session on that risk; a session's count opens it on its first risk.
  const row = { session_id: 'agent-h1', root_id: 'fx', rule: 'deny', first_seq: '31' };
  assert.deepEqual(openTarget('risks', row), { root: 'fx', sel: null, risk: 'agent-h1:deny:31' });
  assert.equal(sessionUrl('fx', null, null, 'agent-h1:deny:31'), '/agents/sessions/fx?risk=agent-h1%3Adeny%3A31');
  assert.equal(sessionUrl('fx', 's:fx:3', 'fx;t1', null), '/agents/sessions/fx?sel=s%3Afx%3A3&marks=fx%3Bt1');
  assert.equal(sessionUrl('fx', null, null, 'first'), '/agents/sessions/fx?risk=first');
});
