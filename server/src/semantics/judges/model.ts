// The model of a judge (spec 6.5, stage 3 of 8.7): one call per judged step, answered as a verdict
// and a reason. Calls that fail for a while are retried by the SDK; what is still failing after
// that becomes an unsure verdict that says why. A key, permission or model that is wrong stops
// the run instead.

import Anthropic from '@anthropic-ai/sdk';
import type { Verdict } from './judge.ts';
import { SYSTEM, userText, VERDICT_SCHEMA } from './prompt.ts';

export interface ModelAnswer { verdict: Verdict; reason: string; inputTokens: number; outputTokens: number }
export interface JudgeModel { judge(model: string, criterion: string, excerpt: string): Promise<ModelAnswer> }

/** The model cannot be used at all: the run stops and says so. */
export class ModelAccessError extends Error {}

const VERDICTS = new Set<string>(['violates', 'ok', 'unsure']);
const MAX_TOKENS = 4096;
/** One attempt of a call, and the attempts after it: a call ends within about three minutes. */
const CALL_TIMEOUT_MS = 60_000;
const CALL_RETRIES = 2;

/** A client of the Anthropic SDK whose calls end well within the minutes after which another runner may take a run. */
export const claudeClient = (options: ConstructorParameters<typeof Anthropic>[0] = {}): Anthropic =>
  new Anthropic({ timeout: CALL_TIMEOUT_MS, maxRetries: CALL_RETRIES, ...options });

function verdictOf(text: string): { verdict: Verdict; reason: string } | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    return typeof v.verdict === 'string' && VERDICTS.has(v.verdict) && typeof v.reason === 'string' ? { verdict: v.verdict as Verdict, reason: v.reason } : null;
  } catch {
    return null;
  }
}

function answerOf(m: Anthropic.Message): ModelAnswer {
  const tokens = { inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens };
  const unsure = (reason: string): ModelAnswer => ({ verdict: 'unsure', reason, ...tokens });
  if (m.stop_reason === 'refusal') return unsure('The model declined to judge this step.');
  if (m.stop_reason === 'max_tokens') return unsure('The answer was cut off before it was complete.');
  const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const v = verdictOf(text);
  return v ? { ...v, ...tokens } : unsure('The answer was not a verdict.');
}

const noTokens = { inputTokens: 0, outputTokens: 0 };

/** A judge model on the Claude API, through a client of the Anthropic SDK. */
export function claudeJudge(client: Pick<Anthropic, 'messages'>): JudgeModel {
  return {
    async judge(model, criterion, excerpt) {
      try {
        const m = await client.messages.create({
          model, max_tokens: MAX_TOKENS, system: SYSTEM,
          messages: [{ role: 'user', content: userText(criterion, excerpt) }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
        });
        return answerOf(m);
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) {
          throw new ModelAccessError(`The model cannot be used: ${e.message}`);
        }
        if (e instanceof Anthropic.BadRequestError) return { verdict: 'unsure', reason: `The model refused the request: ${e.message}`, ...noTokens };
        if (e instanceof Anthropic.APIError) return { verdict: 'unsure', reason: `The model could not be reached: ${e.message}`, ...noTokens };
        throw e;
      }
    },
  };
}
