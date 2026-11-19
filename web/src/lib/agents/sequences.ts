// The Sequences page as data (spec 8.5): its state in the address, a pattern in words, the changes
// the page makes to a pattern, and the pattern a path of the drawing opens as.

import type { Match } from '../../api/sequences.ts';
import { parseRange, rangeParams, type TableRange } from './table.ts';

/** An event of a sequence: a tool call, a user input, a reply that ends a turn, or a compaction. */
export type StepKind = 'call' | 'user' | 'reply' | 'compaction';

export interface Step {
  kind: StepKind;
  tool?: string;
  status?: 'ok' | 'failed';
  /** Text the target of a call, or the text of an input or reply, contains. */
  has?: string;
  /** Words of which the target or text contains at least one. */
  any?: string[];
  /** Number of an earlier step, from 1, with the same target or text. */
  same?: number;
  /** How the event follows the step before; absent on the first step. */
  link?: 'next' | 'later';
}

export const MAX_STEPS = 6;
export const KIND_LABEL: Record<StepKind, string> = { call: 'Tool call', user: 'User input', reply: 'Reply', compaction: 'Compaction' };
const KINDS = Object.keys(KIND_LABEL);
export const LINK_LABEL = { next: 'the very next event of the session', later: 'any later event of the session' } as const;

/** The patterns the paper names: a strategy that does not work, one that does, and an order a safety rule asks for. */
export const EXAMPLES: { name: string; steps: Step[] }[] = [
  { name: 'Edit, failed test, edit the same file', steps: [{ kind: 'call', tool: 'Edit' }, { kind: 'call', tool: 'Bash', status: 'failed', has: 'test', link: 'next' }, { kind: 'call', tool: 'Edit', same: 1, link: 'next' }] },
  { name: 'Search, read, edit, passing test', steps: [{ kind: 'call', tool: 'Grep' }, { kind: 'call', tool: 'Read', link: 'later' }, { kind: 'call', tool: 'Edit', link: 'later' }, { kind: 'call', tool: 'Bash', status: 'ok', has: 'test', link: 'later' }] },
  { name: 'Assistant asks, user confirms, then a command', steps: [{ kind: 'reply', has: 'should i' }, { kind: 'user', link: 'next' }, { kind: 'call', tool: 'Bash', link: 'later' }] },
];

export interface SeqState {
  range: TableRange;
  /** Where the drawing starts: `failed`, `user` or `tool:<name>`. */
  start: string;
  /** The pattern shown, or null for the drawing. */
  pattern: Step[] | null;
  /** `time`, `session`, `agent`, `turn`, `span`, or `step<n>`. */
  sort: string;
  dir: 'asc' | 'desc';
}

const DEFAULT_START = 'failed';
const SORTS = ['time', 'session', 'agent', 'turn', 'span'];

/** The sort of a table of matches of `steps` steps; anything else is the time. */
export function sortOf(raw: string | null, steps: number): string {
  const step = /^step([1-6])$/.exec(raw ?? '');
  return raw && (SORTS.includes(raw) || (step !== null && Number(step[1]) <= steps)) ? raw : 'time';
}

const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** One step as the address spells it, with whatever it spells wrongly left out. */
function cleanStep(raw: unknown, i: number, earlier: readonly Step[]): Step {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = (KINDS.includes(String(r.kind)) ? r.kind : 'call') as StepKind;
  const call = kind === 'call';
  const worded = kind !== 'compaction';
  const any = Array.isArray(r.any) ? r.any.map(textOf).filter((w): w is string => w !== undefined) : [];
  const same = typeof r.same === 'number' && Number.isInteger(r.same) && r.same >= 1 && r.same <= i && earlier[r.same - 1]!.kind !== 'compaction' ? r.same : undefined;
  return {
    kind,
    ...(call && textOf(r.tool) ? { tool: textOf(r.tool) } : {}),
    ...(call && (r.status === 'ok' || r.status === 'failed') ? { status: r.status } : {}),
    ...(worded && textOf(r.has) ? { has: textOf(r.has) } : {}),
    ...(worded && any.length ? { any } : {}),
    ...(worded && same ? { same } : {}),
    ...(i > 0 ? { link: r.link === 'later' ? 'later' as const : 'next' as const } : {}),
  };
}

/** A pattern from what the address holds, or null when it holds none. */
function cleanPattern(raw: string | null): Step[] | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_STEPS) return null;
  return v.reduce<Step[]>((steps, r, i) => [...steps, cleanStep(r, i, steps)], []);
}

/** The state an address holds; anything it does not say, or says wrongly, is the default. */
export function parseSeqState(search: string): SeqState {
  const p = new URLSearchParams(search);
  const start = p.get('start') ?? '';
  const pattern = cleanPattern(p.get('p'));
  return {
    range: parseRange(p),
    start: start === 'user' || /^tool:.+/s.test(start) ? start : DEFAULT_START,
    pattern,
    sort: sortOf(p.get('sort'), pattern?.length ?? 0),
    dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
  };
}

/** The query string of a state; what equals the default is left out. */
export function serializeSeqState(s: SeqState): string {
  const p = new URLSearchParams(rangeParams(s.range));
  if (s.start !== DEFAULT_START) p.set('start', s.start);
  if (s.pattern) {
    p.set('p', JSON.stringify(s.pattern));
    if (s.sort !== 'time') p.set('sort', s.sort);
    if (s.dir !== 'desc') p.set('dir', s.dir);
  }
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** A step in words, as short as the paper writes one: what it is first, then its conditions. */
export function words(s: Step): string[] {
  const call = s.kind === 'call';
  const noun = call ? 'target' : 'text';
  return [
    call ? s.tool ?? 'Any tool' : KIND_LABEL[s.kind],
    ...(s.status ? [s.status] : []),
    ...(s.has ? [`${noun} has "${s.has}"`] : []),
    ...(s.any?.length ? [`${noun} has ${s.any.map((w) => `"${w}"`).join(' or ')}`] : []),
    ...(s.same ? [`same ${noun} as ${s.same}`] : []),
  ];
}

/** A step as the head of its column in the table of matches. */
export const stepLabel = (s: Step): string => (s.kind === 'call' ? s.tool ?? 'Any tool' : KIND_LABEL[s.kind]);

/** The pattern after a step was removed: later steps that named its target name none, and the numbers after it move up. */
export function without(pattern: readonly Step[], i: number): Step[] {
  return pattern.filter((_, n) => n !== i).map((s, n) => {
    const { link, same, ...rest } = s;
    const kept = same === undefined || same === i + 1 ? undefined : same > i + 1 ? same - 1 : same;
    return { ...rest, ...(kept ? { same: kept } : {}), ...(n > 0 ? { link: link ?? 'next' } : {}) };
  });
}

/** The pattern with step `i` changed; a later step cannot share the text of a step that has none. */
export function withStep(pattern: readonly Step[], i: number, step: Step): Step[] {
  return pattern.map((s, n) => {
    if (n === i) return step;
    if (step.kind !== 'compaction' || s.same !== i + 1) return s;
    const { same: _same, ...rest } = s;
    return rest;
  });
}

/** The pattern with one more step: any tool call, right after the last step. */
export const added = (pattern: readonly Step[]): Step[] => [...pattern, { kind: 'call', link: 'next' }];

const NODE_KIND: Record<string, StepKind> = { c: 'call', f: 'call', u: 'user', r: 'reply', x: 'compaction' };

/** An event of the drawing from its key (`c:<tool>`, `f:<tool>`, `u:`, `r:`, `x:`); the empty key ends the session. */
export function nodeOf(key: string): { kind: StepKind | 'end'; tool: string; failed: boolean; label: string } {
  const kind = NODE_KIND[key[0] ?? ''];
  if (!kind || key[1] !== ':') return { kind: 'end', tool: '', failed: false, label: 'session ends' };
  const tool = key.slice(2);
  const failed = key[0] === 'f';
  return { kind, tool: kind === 'call' ? tool : '', failed, label: kind === 'call' ? `${tool}${failed ? ' failed' : ''}` : KIND_LABEL[kind] };
}

/** The start of a drawing in words. */
export const startLabel = (start: string): string => (start === 'failed' ? 'Failed call' : start === 'user' ? 'User input' : start.replace(/^tool:/, ''));

/** The pattern that finds a path of the drawing again: its start, then each event as the next one. */
export function patternOfPath(start: string, keys: readonly string[]): Step[] {
  const first: Step = start === 'failed' ? { kind: 'call', status: 'failed' } : start === 'user' ? { kind: 'user' } : { kind: 'call', tool: start.replace(/^tool:/, '') };
  return [first, ...keys.map((key): Step => {
    const n = nodeOf(key);
    return n.kind === 'call' ? { kind: 'call', tool: n.tool, status: n.failed ? 'failed' : 'ok', link: 'next' } : { kind: n.kind === 'end' ? 'call' : n.kind, link: 'next' };
  })];
}

/** The rows a match marks on the session page, as the address carries them (see `parseMarks`). */
export function matchMarks(m: Match): string {
  const items = m.steps.map((s) => (s.kind === 'user' ? `t${s.turn}` : `${s.kind === 'compaction' ? 'c' : 's'}${s.turn}.${s.step}.${s.kind === 'call' ? s.call ?? s.seq : s.seq}`));
  return `${m.session_id};${items.join(',')}`;
}
