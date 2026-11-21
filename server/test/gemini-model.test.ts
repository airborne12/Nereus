// The judge and fold models on the Gemini API with a stub in place of fetch: the request they send,
// an answer, what a blocked or cut answer becomes, the retries of a call that fails for a while,
// and the errors that stop the pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOLD_SCHEMA } from '../src/semantics/judges/fold-model.ts';
import { GEMINI_URL, geminiClient, geminiFold, geminiJudge } from '../src/semantics/judges/gemini.ts';
import { ModelAccessError } from '../src/semantics/judges/model.ts';
import { SYSTEM, VERDICT_SCHEMA } from '../src/semantics/judges/prompt.ts';

const usage = { promptTokenCount: 900, candidatesTokenCount: 30, thoughtsTokenCount: 12 };
const reply = (text: string, over: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason: 'STOP', ...over }], usageMetadata: usage,
});
const error = (code: number, status: string, message: string, reason?: string) => ({ error: { code, status, message, ...(reason ? { details: [{ reason }] } : {}) } });

/** A fetch that answers each call with the next of `answers`: a status and a body, or a thrown error. */
function stubFetch(answers: ([number, unknown] | Error)[]) {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const a = answers[Math.min(sent.length - 1, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a[1]), { status: a[0], headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, sent };
}
const client = (answers: ([number, unknown] | Error)[]) => {
  const s = stubFetch(answers);
  return { c: geminiClient({ apiKey: 'k-1', fetch: s.f, wait: async () => {} }), sent: s.sent };
};

test('one verdict: the system prompt, the record, a JSON schema, low thinking; the tokens count the thinking', async () => {
  const { c, sent } = client([[200, reply('{"verdict":"violates","reason":"The test was edited."}')]]);
  const got = await geminiJudge(c).judge('gemini-3.5-flash', 'Is the test fitted?', '<step>x</step>');
  assert.deepEqual(got, { verdict: 'violates', reason: 'The test was edited.', inputTokens: 900, outputTokens: 42 });
  assert.equal(sent[0]!.url, `${GEMINI_URL}/models/gemini-3.5-flash:generateContent`);
  assert.equal(sent[0]!.headers['x-goog-api-key'], 'k-1');
  const { contents, ...rest } = sent[0]!.body as { contents: { role: string; parts: { text: string }[] }[] };
  assert.deepEqual(rest, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: VERDICT_SCHEMA, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } },
  });
  assert.equal(contents[0]!.role, 'user');
  assert.match(contents[0]!.parts[0]!.text, /<step>x<\/step>[\s\S]*Is the test fitted\?/);
});

test('an answer that is not a verdict is unsure, with why and the tokens it took', async () => {
  const cases: [unknown, string][] = [
    [reply('{"verdict":"ok"', { finishReason: 'MAX_TOKENS' }), 'The answer was cut off before it was complete.'],
    [reply('', { finishReason: 'SAFETY' }), 'The model declined to judge this step.'],
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: usage }, 'The model declined to judge this step.'],
    [reply('{"verdict":"maybe","reason":"x"}'), 'The answer was not a verdict.'],
  ];
  for (const [body, reason] of cases) {
    const got = await geminiJudge(client([[200, body]]).c).judge('gemini-3.5-flash', 'c', 'x');
    assert.deepEqual([got.verdict, got.reason, got.inputTokens], ['unsure', reason, 900], reason);
  }
});

test('a call that fails for a while is tried three times, then did not reach the model; a refused request is unsure', async () => {
  const busy = client([[503, error(503, 'UNAVAILABLE', 'overloaded')]]);
  const got = await geminiJudge(busy.c).judge('gemini-3.5-flash', 'c', 'x');
  assert.deepEqual([got.verdict, got.reason, got.inputTokens, busy.sent.length], ['unsure', 'The model could not be reached: overloaded', 0, 3]);
  const later = client([[429, error(429, 'RESOURCE_EXHAUSTED', 'quota')], new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), [200, reply('{"verdict":"ok","reason":"Fine."}')]]);
  assert.equal((await geminiJudge(later.c).judge('gemini-3.5-flash', 'c', 'x')).verdict, 'ok');
  assert.equal(later.sent.length, 3);
  const refused = await geminiJudge(client([[400, error(400, 'INVALID_ARGUMENT', 'bad schema')]]).c).judge('gemini-3.5-flash', 'c', 'x');
  assert.deepEqual([refused.verdict, refused.reason, refused.inputTokens], ['unsure', 'The model refused the request: bad schema', 0]);
});

test('a key, permission, region or model that is wrong stops the pass; so does a key that is not set', async () => {
  for (const [status, body] of [
    [400, error(400, 'INVALID_ARGUMENT', 'API key not valid.', 'API_KEY_INVALID')],
    [400, error(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.')],
    [403, error(403, 'PERMISSION_DENIED', 'blocked')],
    [404, error(404, 'NOT_FOUND', 'models/gemini-0 is not found')],
  ] as const) {
    await assert.rejects(geminiJudge(client([[status, body]]).c).judge('gemini-3.5-flash', 'c', 'x'), ModelAccessError, `${status}`);
  }
  await assert.rejects(geminiJudge(geminiClient({ apiKey: undefined })).judge('gemini-3.5-flash', 'c', 'x'), /GEMINI_API_KEY is not set/);
});

test('a key with characters a key cannot have stops the pass without being sent or quoted', async () => {
  const s = stubFetch([[200, reply('{"verdict":"ok","reason":"x"}')]]);
  const judged = geminiJudge(geminiClient({ apiKey: 'k-1\nsecret-part', fetch: s.f })).judge('gemini-3.5-flash', 'c', 'x');
  await assert.rejects(judged, (e: Error) => e instanceof ModelAccessError && /GEMINI_API_KEY/.test(e.message) && !e.message.includes('secret-part'));
  assert.equal(s.sent.length, 0);
});

test('only a connection or a timeout counts as not reaching the model, with its cause; another error is thrown', async () => {
  const refused = client([new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })]);
  const got = await geminiJudge(refused.c).judge('gemini-3.5-flash', 'c', 'x');
  assert.deepEqual([got.reason, refused.sent.length], ['The model could not be reached: fetch failed (ECONNREFUSED)', 3]);
  const slow = await geminiJudge(client([Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]).c).judge('gemini-3.5-flash', 'c', 'x');
  assert.equal(slow.reason, 'The model could not be reached: the call timed out');
  const odd = client([new RangeError('something else')]);
  await assert.rejects(geminiJudge(odd.c).judge('gemini-3.5-flash', 'c', 'x'), RangeError);
  assert.equal(odd.sent.length, 1);
});

test('one update of the fold: its schema, the update, a missed call and what stops the pass', async () => {
  const { c, sent } = client([[200, reply('{"evidence":"conflicts","state":"outdated","reason":"Renamed."}')]]);
  assert.deepEqual(await geminiFold(c).fold('gemini-3.5-flash', 'You keep track of a memory.', '<memory>x</memory>'),
    { evidence: 'conflicts', state: 'outdated', reason: 'Renamed.', inputTokens: 900, outputTokens: 42 });
  assert.deepEqual([(sent[0]!.body.systemInstruction as { parts: { text: string }[] }).parts[0]!.text, (sent[0]!.body.generationConfig as { responseJsonSchema: unknown }).responseJsonSchema],
    ['You keep track of a memory.', FOLD_SCHEMA]);
  const cut = await geminiFold(client([[200, reply('{"evidence":', { finishReason: 'MAX_TOKENS' })]]).c).fold('m', 's', 't');
  assert.deepEqual(cut, { missed: 'The answer was cut off before it was complete.', inputTokens: 900, outputTokens: 42 });
  const declined = await geminiFold(client([[200, reply('', { finishReason: 'SAFETY' })]]).c).fold('m', 's', 't');
  assert.equal('missed' in declined && declined.missed, 'The model declined to judge this session.');
  const down = await geminiFold(client([[500, error(500, 'INTERNAL', 'boom')]]).c).fold('m', 's', 't');
  assert.deepEqual(down, { missed: 'The model could not be reached: boom', inputTokens: 0, outputTokens: 0 });
  await assert.rejects(geminiFold(client([[403, error(403, 'PERMISSION_DENIED', 'blocked')]]).c).fold('m', 's', 't'), ModelAccessError);
});
