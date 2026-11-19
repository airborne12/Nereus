// The model of the validity fold with a stub in place of the Anthropic SDK client: the request it
// sends, an answer, and what a refusal, a cut answer, a failed call or a wrong key becomes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { claudeFold, FOLD_SCHEMA } from '../src/semantics/judges/fold-model.ts';
import { ModelAccessError } from '../src/semantics/judges/model.ts';

const usage = { input_tokens: 900, output_tokens: 40 };
const message = (over: Record<string, unknown>) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [], usage, ...over });
const text = (t: string) => ({ type: 'text', text: t });

function client(answer: () => unknown) {
  const sent: unknown[] = [];
  const c = { messages: { create: async (body: unknown) => { sent.push(body); return answer(); } } } as unknown as Anthropic;
  return { c, sent };
}

test('one update of the fold: the system prompt, the record, a schema of evidence, state and reason, low effort', async () => {
  const { c, sent } = client(() => message({ content: [text('{"evidence":"conflicts","state":"outdated","reason":"The flag was renamed."}')] }));
  const got = await claudeFold(c).fold('claude-haiku-5-5', 'You keep track of a memory.', '<memory>x</memory>');
  assert.deepEqual(got, { evidence: 'conflicts', state: 'outdated', reason: 'The flag was renamed.', inputTokens: 900, outputTokens: 40 });
  assert.deepEqual(sent, [{
    model: 'claude-haiku-5-5', max_tokens: 4096, system: 'You keep track of a memory.', messages: [{ role: 'user', content: '<memory>x</memory>' }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: FOLD_SCHEMA } },
  }]);
  assert.deepEqual(FOLD_SCHEMA.required, ['evidence', 'state', 'reason']);
});

test('an answer that is not an update is missed, with why and the tokens it took; a failed call took none', async () => {
  const cases: [() => unknown, string, number][] = [
    [() => message({ stop_reason: 'refusal' }), 'The model declined to judge this session.', 900],
    [() => message({ stop_reason: 'max_tokens', content: [text('{"evidence":')] }), 'The answer was cut off before it was complete.', 900],
    [() => message({ content: [text('{"evidence":"maybe","state":"holds","reason":"x"}')] }), 'The answer was not an update of the state.', 900],
    [() => { throw new Anthropic.APIError(529, { error: { message: 'overloaded' } }, undefined, new Headers()); }, 'The model could not be reached: 529', 0],
  ];
  for (const [answer, reason, tokens] of cases) {
    const got = await claudeFold(client(answer).c).fold('m', 's', 't');
    assert.ok('missed' in got, reason);
    assert.ok(got.missed.startsWith(reason), `${got.missed} / ${reason}`);
    assert.equal(got.inputTokens, tokens);
  }
});

test('a key, permission or model that is wrong stops the pass', async () => {
  const wrong = () => { throw new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, undefined, new Headers()); };
  await assert.rejects(claudeFold(client(wrong).c).fold('m', 's', 't'), ModelAccessError);
});
