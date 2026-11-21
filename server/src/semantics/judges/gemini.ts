// The judge and fold models on the Gemini API: one generateContent call per record, answered through
// a JSON schema. A call that fails for a while is tried again, then counts as not reaching the model;
// a key, permission, region or model that is wrong stops the pass, as it does for Claude. A proxy is
// set for the process (NODE_USE_ENV_PROXY=1 with HTTPS_PROXY), not here.

import { FOLD_SCHEMA, type FoldAnswer, type FoldMissed, type FoldModel, updateOf } from './fold-model.ts';
import { type JudgeModel, ModelAccessError, type ModelAnswer, verdictOf } from './model.ts';
import { SYSTEM, userText, VERDICT_SCHEMA } from './prompt.ts';

export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TOKENS = 4096;
/** One attempt of a call, and the attempts after it: a call ends within about three minutes. */
const CALL_TIMEOUT_MS = 60_000;
const CALL_RETRIES = 2;
/** Finish reasons of an answer the model would not give. */
const DECLINED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'OTHER']);

/** What one call gave: the answer's text, why it ended, why the request was blocked, and its tokens with the thinking. */
export interface GeminiReply { text: string; finish: string | null; blocked: string | null; inputTokens: number; outputTokens: number }
export interface GeminiClient { generate(model: string, system: string, text: string, schema: object): Promise<GeminiReply> }

/** An error answer of the API: its HTTP status (0 when it was not reached), its reason and message. */
export class GeminiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

interface ClientOptions { apiKey: string | undefined; fetch?: typeof fetch; baseUrl?: string; wait?: (ms: number) => Promise<void> }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** What a key can hold: visible ASCII, so it is never echoed back in the error of a header it breaks. */
const KEY = /^[\x21-\x7e]+$/;

/** Why fetch got no answer, when the connection failed or the call timed out; null for any other error. */
function unreached(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'the call timed out';
  if (!(e instanceof TypeError) || e.message !== 'fetch failed') return null;
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `fetch failed (${code})` : 'fetch failed';
}
const retryable = (e: GeminiError): boolean => e.status === 0 || e.status === 429 || e.status >= 500;

function replyOf(d: Record<string, any>): GeminiReply {
  const c = d.candidates?.[0];
  const parts: { text?: string; thought?: boolean }[] = c?.content?.parts ?? [];
  const u = d.usageMetadata ?? {};
  return {
    text: parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join(''),
    finish: c?.finishReason ?? null, blocked: d.promptFeedback?.blockReason ?? null,
    inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

async function errorOf(res: Response): Promise<GeminiError> {
  const e = ((await res.json().catch(() => ({}))) as Record<string, any>).error ?? {};
  const reason = e.details?.find((x: { reason?: string }) => x.reason)?.reason ?? e.status ?? String(res.status);
  return new GeminiError(res.status, reason, e.message ?? res.statusText);
}

/** A client of the Gemini API through fetch, with the key in a header. */
export function geminiClient(o: ClientOptions): GeminiClient {
  const f = o.fetch ?? fetch;
  const wait = o.wait ?? sleep;
  return {
    async generate(model, system, text, schema) {
      if (!o.apiKey) throw new ModelAccessError('The model cannot be used: GEMINI_API_KEY is not set');
      if (!KEY.test(o.apiKey)) throw new ModelAccessError('The model cannot be used: GEMINI_API_KEY holds characters a key cannot have');
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: MAX_TOKENS, thinkingConfig: { thinkingLevel: 'low' } },
      });
      const url = `${o.baseUrl ?? GEMINI_URL}/models/${encodeURIComponent(model)}:generateContent`;
      let last = new GeminiError(0, 'UNREACHABLE', 'no attempt');
      for (let attempt = 0; attempt <= CALL_RETRIES; attempt += 1) {
        if (attempt) await wait(1000 * 2 ** (attempt - 1));
        try {
          const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': o.apiKey }, body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
          if (res.ok) return replyOf((await res.json()) as Record<string, any>);
          last = await errorOf(res);
        } catch (e) {
          const why = unreached(e);
          if (why === null) throw e;
          last = new GeminiError(0, 'UNREACHABLE', why);
        }
        if (!retryable(last)) break;
      }
      throw last;
    },
  };
}

/** Whether an error means the model cannot be used at all: a wrong key, permission, region or model. */
const noAccess = (e: GeminiError): boolean =>
  e.status === 401 || e.status === 403 || e.status === 404 || (e.status === 400 && (e.reason === 'API_KEY_INVALID' || e.reason === 'FAILED_PRECONDITION'));

/** Why an answer is not one, or null when it is. */
const notAnswered = (r: GeminiReply, what: string): string | null =>
  r.blocked || (r.finish && DECLINED.has(r.finish)) ? `The model declined to judge this ${what}.`
    : r.finish === 'MAX_TOKENS' ? 'The answer was cut off before it was complete.' : null;

/** A judge model on the Gemini API. */
export function geminiJudge(client: GeminiClient): JudgeModel {
  return {
    async judge(model, criterion, excerpt, system) {
      try {
        const r = await client.generate(model, system ?? SYSTEM, userText(criterion, excerpt), VERDICT_SCHEMA);
        const tokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
        const why = notAnswered(r, 'step');
        const v = why ? null : verdictOf(r.text);
        return v ? { ...v, ...tokens } : ({ verdict: 'unsure', reason: why ?? 'The answer was not a verdict.', ...tokens } satisfies ModelAnswer);
      } catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        if (noAccess(e)) throw new ModelAccessError(`The model cannot be used: ${e.message}`);
        const said = e.status === 400 ? 'The model refused the request' : 'The model could not be reached';
        return { verdict: 'unsure', reason: `${said}: ${e.message}`, inputTokens: 0, outputTokens: 0 };
      }
    },
  };
}

/** A fold model on the Gemini API. */
export function geminiFold(client: GeminiClient): FoldModel {
  return {
    async fold(model, system, text): Promise<FoldAnswer | FoldMissed> {
      try {
        const r = await client.generate(model, system, text, FOLD_SCHEMA);
        const tokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
        const why = notAnswered(r, 'session');
        const u = why ? null : updateOf(r.text);
        return u ? { ...u, ...tokens } : { missed: why ?? 'The answer was not an update of the state.', ...tokens };
      } catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        if (noAccess(e)) throw new ModelAccessError(`The model cannot be used: ${e.message}`);
        return { missed: `The model could not be reached: ${e.message}`, inputTokens: 0, outputTokens: 0 };
      }
    },
  };
}
