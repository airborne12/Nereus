// The model client of the judges with a stub in place of the Anthropic SDK client: the request it
// sends, and what each kind of answer or failure becomes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { claudeClient, claudeJudge, ModelAccessError } from '../src/semantics/judges/model.ts';
import { SYSTEM, userText, VERDICT_SCHEMA } from '../src/semantics/judges/prompt.ts';

const usage = { input_tokens: 812, output_tokens: 64 };
const message = (over: Partial<Record<string, unknown>>) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [], usage, ...over });
const text = (t: string) => ({ type: 'text', text: t });

function client(answer: () => unknown) {
  const sent: unknown[] = [];
  const c = { messages: { create: async (body: unknown) => { sent.push(body); return answer(); } } } as unknown as Anthropic;
  return { c, sent };
}

test('a step is judged with the criterion, the record, a verdict schema and low effort', async () => {
  const { c, sent } = client(() => message({ content: [{ type: 'thinking', thinking: '', signature: 's' }, text('{"verdict":"violates","reason":"It changes the expected date."}')] }));
  const got = await claudeJudge(c).judge('claude-haiku-5-5', 'Is the test fitted?', '<step judged="true">\nx\n</step>');
  assert.deepEqual(got, { verdict: 'violates', reason: 'It changes the expected date.', inputTokens: 812, outputTokens: 64 });
  assert.deepEqual(sent, [{
    model: 'claude-haiku-5-5', max_tokens: 4096, system: SYSTEM,
    messages: [{ role: 'user', content: userText('Is the test fitted?', '<step judged="true">\nx\n</step>') }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
  }]);
});

test('an answer that is not a verdict is unsure, and says why', async () => {
  const cases: [unknown, string][] = [
    [message({ stop_reason: 'refusal', content: [] }), 'The model declined to judge this step.'],
    [message({ stop_reason: 'max_tokens', content: [text('{"verdict":')] }), 'The answer was cut off before it was complete.'],
    [message({ content: [text('not json')] }), 'The answer was not a verdict.'],
    [message({ content: [text('{"verdict":"maybe","reason":"x"}')] }), 'The answer was not a verdict.'],
    [message({ content: [text('{"verdict":"ok"}')] }), 'The answer was not a verdict.'],
  ];
  for (const [answer, reason] of cases) {
    const got = await claudeJudge(client(() => answer).c).judge('claude-haiku-5-5', 'c', 'x');
    assert.deepEqual(got, { verdict: 'unsure', reason, inputTokens: 812, outputTokens: 64 }, reason);
  }
});

test('a model that cannot be reached after the retries gives unsure with the error; a refused request too', async () => {
  const failing = (e: Error) => claudeJudge(client(() => { throw e; }).c).judge('claude-haiku-5-5', 'c', 'x');
  const limited = new Anthropic.RateLimitError(429, { message: 'rate limited' }, undefined, new Headers());
  assert.deepEqual(await failing(limited), { verdict: 'unsure', reason: `The model could not be reached: ${limited.message}`, inputTokens: 0, outputTokens: 0 });
  assert.equal((await failing(new Anthropic.APIConnectionError({ message: 'socket hang up' }))).reason, 'The model could not be reached: socket hang up');
  const busy = new Anthropic.InternalServerError(529, { message: 'overloaded' }, undefined, new Headers());
  assert.equal((await failing(busy)).reason, `The model could not be reached: ${busy.message}`);
  const long = new Anthropic.BadRequestError(400, { message: 'prompt is too long' }, undefined, new Headers());
  assert.equal((await failing(long)).reason, `The model refused the request: ${long.message}`);
});

test('a call is bounded well under the ten quiet minutes after which another runner may take a run', () => {
  const c = claudeClient({ apiKey: 'not-a-key' });
  assert.deepEqual([c.timeout, c.maxRetries], [60_000, 2]);
});

test('a key, a permission or a model that is wrong stops the run instead of filling it with unsure verdicts', async () => {
  const h = new Headers();
  for (const e of [new Anthropic.AuthenticationError(401, { message: 'invalid x-api-key' }, undefined, h), new Anthropic.PermissionDeniedError(403, { message: 'no access' }, undefined, h), new Anthropic.NotFoundError(404, { message: 'model: claude-x' }, undefined, h)]) {
    await assert.rejects(claudeJudge(client(() => { throw e; }).c).judge('claude-haiku-5-5', 'c', 'x'), (err: Error) => err instanceof ModelAccessError && err.message === `The model cannot be used: ${e.message}`);
  }
  // Anything else is a fault of this program and is not hidden as a verdict.
  await assert.rejects(claudeJudge(client(() => { throw new TypeError('boom'); }).c).judge('claude-haiku-5-5', 'c', 'x'), /boom/);
});
