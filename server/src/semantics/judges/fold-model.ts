// The model of a fold judge (spec 3, 6.5): one call per new piece of evidence, answered as the
// evidence it is, the state after it and why. A call that gives no such answer is missed: the
// evidence is judged again on the next pass. A key, permission or model that is wrong stops it.

import Anthropic from '@anthropic-ai/sdk';
import { ModelAccessError } from './model.ts';

export type Evidence = 'supports' | 'conflicts' | 'none';
export type FoldState = 'holds' | 'doubt' | 'outdated';
export interface FoldAnswer { evidence: Evidence; state: FoldState; reason: string; inputTokens: number; outputTokens: number }
/** A call that gave no update, and why. */
export interface FoldMissed { missed: string; inputTokens: number; outputTokens: number }
export interface FoldModel { fold(model: string, system: string, text: string): Promise<FoldAnswer | FoldMissed> }

export const FOLD_SCHEMA = {
  type: 'object',
  properties: {
    evidence: { type: 'string', enum: ['supports', 'conflicts', 'none'] },
    state: { type: 'string', enum: ['holds', 'doubt', 'outdated'] },
    reason: { type: 'string' },
  },
  required: ['evidence', 'state', 'reason'],
  additionalProperties: false,
};

const EVIDENCE = new Set<string>(['supports', 'conflicts', 'none']);
const STATES = new Set<string>(['holds', 'doubt', 'outdated']);
const MAX_TOKENS = 4096;

export function updateOf(text: string): Pick<FoldAnswer, 'evidence' | 'state' | 'reason'> | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (typeof v.evidence !== 'string' || typeof v.state !== 'string' || typeof v.reason !== 'string') return null;
    return EVIDENCE.has(v.evidence) && STATES.has(v.state) ? { evidence: v.evidence as Evidence, state: v.state as FoldState, reason: v.reason } : null;
  } catch {
    return null;
  }
}

function answerOf(m: Anthropic.Message): FoldAnswer | FoldMissed {
  const tokens = { inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens };
  if (m.stop_reason === 'refusal') return { missed: 'The model declined to judge this session.', ...tokens };
  if (m.stop_reason === 'max_tokens') return { missed: 'The answer was cut off before it was complete.', ...tokens };
  const update = updateOf(m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''));
  return update ? { ...update, ...tokens } : { missed: 'The answer was not an update of the state.', ...tokens };
}

/** A fold model on the Claude API, through a client of the Anthropic SDK. */
export function claudeFold(client: Pick<Anthropic, 'messages'>): FoldModel {
  return {
    async fold(model, system, text) {
      try {
        const m = await client.messages.create({
          model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: text }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: FOLD_SCHEMA } },
        });
        return answerOf(m);
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) {
          throw new ModelAccessError(`The model cannot be used: ${e.message}`);
        }
        if (e instanceof Anthropic.APIError) return { missed: `The model could not be reached: ${e.message}`, inputTokens: 0, outputTokens: 0 };
        throw e;
      }
    },
  };
}
