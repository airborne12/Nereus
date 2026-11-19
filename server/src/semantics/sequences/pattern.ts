// A sequence pattern (spec 8.5): up to six steps. Each step puts conditions on one event, and from
// the second step on says whether that event is the next one of its session or any later one.

import { CompileError } from '../search/compile.ts';

/** An event of a sequence: a tool call, a user input, a reply that ends a turn, or a compaction. */
export type StepKind = 'call' | 'user' | 'reply' | 'compaction';

export interface Step {
  kind: StepKind;
  /** Tool name; tool calls only. */
  tool?: string;
  /** Outcome; tool calls only. */
  status?: 'ok' | 'failed';
  /** Lower-case text the target (of a call) or the text (of an input or reply) contains. */
  has?: string;
  /** Lower-case words of which the target or text contains at least one. */
  any?: string[];
  /** Number of an earlier step, from 1, whose target or text this event shares. */
  same?: number;
  /** How the event follows the step before; absent on the first step. */
  link?: 'next' | 'later';
  /** A regular expression the lower-case target matches. Safety rules write it; a request cannot carry one. */
  re?: string;
}

export const MAX_STEPS = 6;
const MAX_TOOL = 256;
const MAX_HAS = 200;
const MAX_ANY = 20;
const KINDS: readonly string[] = ['call', 'user', 'reply', 'compaction'];
const KEYS: readonly string[] = ['kind', 'tool', 'status', 'has', 'any', 'same', 'link'];

/** A text condition, trimmed; empty text is no condition. */
function textOf(v: unknown, name: string, max: number, fail: (m: string) => never): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return fail(`'${name}' must be text`);
  const t = v.trim();
  if (t.length > max) return fail(`'${name}' is longer than ${max} characters`);
  return t === '' ? undefined : t;
}

function stepOf(raw: unknown, i: number, earlier: readonly Step[]): Step {
  const fail = (m: string): never => { throw new CompileError(`step ${i + 1}: ${m}`); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('must be an object');
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).find((k) => !KEYS.includes(k));
  if (unknown) return fail(`unknown condition '${unknown}'`);

  const kind = (r.kind ?? 'call') as StepKind;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return fail(`unknown event '${String(r.kind)}'`);
  const tool = textOf(r.tool, 'tool', MAX_TOOL, fail);
  const status = textOf(r.status, 'status', 16, fail);
  const has = textOf(r.has, 'has', MAX_HAS, fail)?.toLowerCase();
  if (tool && kind !== 'call') return fail('only a tool call has a tool');
  if (status && kind !== 'call') return fail('only a tool call has a status');
  if (status && status !== 'ok' && status !== 'failed') return fail("'status' must be ok or failed");

  let any: string[] | undefined;
  if (r.any !== undefined && r.any !== null) {
    if (!Array.isArray(r.any) || r.any.length > MAX_ANY) return fail(`'any' must be a list of at most ${MAX_ANY} words`);
    const words = r.any.map((w) => textOf(w, 'any', MAX_HAS, fail)?.toLowerCase()).filter((w): w is string => w !== undefined);
    any = words.length ? words : undefined;
  }

  const same = r.same === undefined || r.same === null || r.same === 0 || r.same === '' ? undefined : r.same;
  if (same !== undefined) {
    if (typeof same !== 'number' || !Number.isInteger(same) || same < 1 || same > i) return fail("'same' must name an earlier step");
    if (earlier[same - 1]!.kind === 'compaction') return fail(`step ${same} is a compaction and has no text`);
  }
  if (kind === 'compaction' && (has || any || same !== undefined)) return fail('a compaction has no text');

  if (i === 0 && r.link !== undefined && r.link !== null) return fail('the first step follows nothing');
  if (i > 0 && r.link !== 'next' && r.link !== 'later') return fail("'link' must be next or later");

  return {
    kind,
    ...(tool ? { tool } : {}),
    ...(status ? { status: status as 'ok' | 'failed' } : {}),
    ...(has ? { has } : {}),
    ...(any ? { any } : {}),
    ...(same !== undefined ? { same: same as number } : {}),
    ...(i > 0 ? { link: r.link as 'next' | 'later' } : {}),
  };
}

/** The pattern of a request, checked; anything else is refused before it reaches SQL. */
export function parsePattern(raw: unknown): Step[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_STEPS) throw new CompileError(`a pattern has 1 to ${MAX_STEPS} steps`);
  return raw.reduce<Step[]>((steps, r, i) => [...steps, stepOf(r, i, steps)], []);
}
