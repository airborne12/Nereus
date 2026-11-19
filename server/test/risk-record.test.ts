// What the model reads for a safety risk, put together from the rows of the risk reads statement:
// the rule and why it fired, then the events in their order, the ones the rule matched marked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CHARS } from '../src/semantics/judges/prompt.ts';
import { RISK_SYSTEM, riskExcerptsOf } from '../src/semantics/judges/risk-record.ts';

type Row = Record<string, unknown>;
const RULE = { session_id: 's-1', rule: 'confirm', first_seq: 31, rule_name: "Irreversible command without the user's confirmation", why: 'The last thing the user said before it was "Tidy it up", and the assistant did not ask before running it.' };
const ev = (seq: number, event_kind: string, step: number, marked: number, extra: Row = {}): Row =>
  ({ ...RULE, seq, event_kind, step, marked, name: null, status: 'ok', target: '', args: null, msg_seq: null, kind: null, is_error: null, text: null, ...extra });

// A user's input carries the step of the reply before it, as the import numbers them; `marked` is
// set on the events the rule matched, not on their steps.
const ROWS: Row[] = [
  ev(28, 'llm_call', 8, 0, { msg_seq: 50, kind: 'text', text: 'Done. Shall I clean up?' }),
  ev(29, 'user_input', 8, 1, { msg_seq: 51, kind: 'text', text: 'Tidy it up' }),
  ev(30, 'llm_call', 9, 0),
  ev(31, 'tool_call', 9, 1, { name: 'Bash', target: 'rm -rf build', args: '{"command":"rm -rf build"}', msg_seq: 53, kind: 'tool_result', text: 'ok <done>' }),
];

test('a risk reads as the rule and why it fired, then its events in order, the matched ones marked', () => {
  const [x] = riskExcerptsOf(ROWS, [{ session_id: 's-1', rule: 'confirm', first_seq: 31 }]);
  assert.deepEqual([x!.subject, x!.session_id, x!.seq, x!.inputSeqs], ['s-1:confirm:31', 's-1', 31, [28, 29, 30, 31]]);
  assert.equal(x!.text, [
    `<rule>Irreversible command without the user's confirmation: The last thing the user said before it was "Tidy it up", and the assistant did not ask before running it.</rule>`,
    '<step>\nAssistant: Done. Shall I clean up?\n</step>',
    '<user judged="true">\nTidy it up\n</user>',
    '<step judged="true">\nCalled Bash: rm -rf build\nResult: ok &lt;done&gt;\n</step>',
  ].join('\n'));
  assert.match(RISK_SYSTEM, /a rule found/);
  assert.match(RISK_SYSTEM, /judged="true"/);
  assert.deepEqual(riskExcerptsOf(ROWS, [{ session_id: 's-9', rule: 'confirm', first_seq: 31 }]), [], 'a risk without rows has no excerpt');
});

test('a long risk leaves out its earliest unmarked steps first, and says so', () => {
  const long = Array.from({ length: 40 }, (_, i) => ev(100 + i, 'llm_call', 20 + i, i === 39 ? 1 : 0, { msg_seq: 200 + i, kind: 'text', text: 'x'.repeat(1900) }));
  const [x] = riskExcerptsOf([ev(99, 'user_input', 20, 1, { msg_seq: 199, kind: 'text', text: 'go' }), ...long].map((r) => ({ ...r, first_seq: 99 })), [{ session_id: 's-1', rule: 'confirm', first_seq: 99 }]);
  assert.ok(x!.text.length <= MAX_CHARS, `${x!.text.length}`);
  assert.match(x!.text, /^<rule>.*<\/rule>\n<user judged="true">\ngo\n<\/user>\n<omitted steps="\d+"\/>\n<step>/s);
  assert.ok(x!.text.endsWith('</step>') && x!.text.includes('<step judged="true">'));
  assert.ok(!x!.inputSeqs.includes(100), 'a step left out is not among the events read');
});
