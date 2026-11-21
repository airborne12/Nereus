// Which provider answers a model: a model named gemini-* goes to the Gemini API, any other to the
// Claude API, each made on first use; and the model the judges kept in code use, from JUDGE_MODEL.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeModelOf } from '../src/cli/run-judges.ts';
import type { FoldModel } from '../src/semantics/judges/fold-model.ts';
import { MODELS } from '../src/semantics/judges/judge.ts';
import type { JudgeModel } from '../src/semantics/judges/model.ts';
import { isGemini, routedModels } from '../src/semantics/judges/providers.ts';

/** A provider whose models say which provider answered, and how often it was made. */
function provider(name: string) {
  let made = 0;
  const make = () => {
    made += 1;
    return {
      judge: { judge: async () => ({ verdict: 'ok' as const, reason: name, inputTokens: 1, outputTokens: 1 }) } as JudgeModel,
      fold: { fold: async () => ({ evidence: 'none' as const, state: 'holds' as const, reason: name, inputTokens: 1, outputTokens: 1 }) } as FoldModel,
    };
  };
  return { make, made: () => made };
}

test('a gemini-* model goes to the Gemini provider, any other to Claude; a provider is made once, on first use', async () => {
  const claude = provider('claude');
  const gemini = provider('gemini');
  const m = routedModels({ claude: claude.make, gemini: gemini.make });
  assert.equal(claude.made() + gemini.made(), 0, 'nothing is made before a call');
  assert.equal((await m.judge.judge('gemini-3.5-flash', 'c', 'x')).reason, 'gemini');
  assert.equal((await m.judge.judge('claude-haiku-5-5', 'c', 'x')).reason, 'claude');
  const folded = await m.fold.fold('gemini-3.5-flash', 's', 't');
  assert.equal('reason' in folded && folded.reason, 'gemini');
  await m.judge.judge('gemini-3.5-flash', 'c', 'x');
  assert.deepEqual([claude.made(), gemini.made()], [1, 1]);
  assert.deepEqual([isGemini('gemini-3.5-flash'), isGemini('claude-haiku-5-5')], [true, false]);
});

test('the models offered include Gemini, and JUDGE_MODEL must be one of them', () => {
  assert.ok(MODELS.includes('gemini-3.5-flash' as (typeof MODELS)[number]));
  assert.equal(judgeModelOf({}), undefined, 'unset keeps the model each judge has in code');
  assert.equal(judgeModelOf({ JUDGE_MODEL: 'gemini-3.5-flash' }), 'gemini-3.5-flash');
  assert.throws(() => judgeModelOf({ JUDGE_MODEL: 'gpt-9' }), /JUDGE_MODEL must be one of claude-haiku-5-5, claude-sonnet-5-5, gemini-3.5-flash/);
});
