// The right side of the session page as a chat between roles: blocks become turns to speak, the
// assistant on the left, whoever it talks with on the right, notices in the middle.

import type { Row } from '../../api/agents.ts';
import { num, text, timeOf } from './format.ts';

/** One content block as the chat needs it. The last fields come only with a step's output. */
export interface Block {
  seq: number;
  ts: number | null;
  role: string;
  kind: string;
  apiMsg: number;
  tool: string;
  callId: string;
  failed: boolean;
  tokens: number;
  text: string;
  /** Length of the whole text; `text` holds at most the first 100,000 characters. */
  chars: number;
  /** For a tool result of a step's output: the call it answers. */
  call?: { seq: number; name: string; resource: string; durationUs: number; repeatOf: number | null; repeatVisible: boolean };
}

export function blockOf(r: Row): Block {
  const base: Block = {
    seq: num(r.msg_seq), ts: timeOf(r.ts), role: text(r.msg_role), kind: text(r.kind), apiMsg: num(r.api_msg), tool: text(r.tool_name),
    callId: text(r.tool_call_id), failed: num(r.is_error) === 1 || r.status === 'error', tokens: num(r.tokens), text: text(r.text), chars: num(r.chars),
  };
  if (r.event_kind !== 'tool_call') return base;
  return {
    ...base,
    call: {
      seq: num(r.event_seq), name: text(r.name), resource: text(r.resource), durationUs: num(r.duration_us),
      repeatOf: r.repeat_of === null || r.repeat_of === undefined ? null : num(r.repeat_of), repeatVisible: num(r.repeat_visible) === 1,
    },
  };
}

export type Speaker = 'system' | 'summary' | 'attachment' | 'user' | 'assistant' | 'tool' | 'agent';
/** Tools that start a sub-agent: their result is the sub-agent's answer. */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** A summary is sent in the user role and a sub-agent answers in the tool role; the page names each for what it is. */
export function speakerOf(b: Block): Speaker {
  if (b.kind === 'summary') return 'summary';
  // What a runtime injects in the user role is a notice; a request's own copy of a tool result or an answer keeps its speaker.
  if (b.kind === 'attachment' && b.role === 'user') return 'attachment';
  if (b.role === 'system') return 'system';
  if (b.role === 'tool') return AGENT_TOOLS.has(b.tool) ? 'agent' : 'tool';
  return b.role === 'assistant' ? 'assistant' : 'user';
}

/** One speaker's turn to talk. */
export interface Group { who: Speaker; parts: Block[] }

/** Blocks as a chat: neighbours of one speaker share a group. Empty blocks, such as withheld thinking, are left out. */
export function groups(blocks: readonly Block[]): Group[] {
  return blocks.filter((b) => b.text !== '' || b.kind === 'tool_use').reduce<Group[]>((acc, b) => {
    const who = speakerOf(b);
    const last = acc[acc.length - 1];
    // Each sub-agent answer stands alone; attachments are notices of their own.
    const joins = last && last.who === who && who !== 'agent' && who !== 'attachment' && who !== 'summary';
    return joins ? [...acc.slice(0, -1), { who, parts: [...last.parts, b] }] : [...acc, { who, parts: [b] }];
  }, []);
}

/** What the assistant said in one API message shares a bubble: its text, then the calls it made. */
export function bubbles(parts: readonly Block[]): Block[][] {
  return parts.reduce<Block[][]>((acc, b) => {
    const last = acc[acc.length - 1];
    return last && last[0]!.apiMsg === b.apiMsg ? [...acc.slice(0, -1), [...last, b]] : [...acc, [b]];
  }, []);
}

/** The arguments a tool call is best known by, in the order tried. */
const MAIN_ARGS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];
/** Characters of a call's arguments shown on one line. */
const CALL_CHARS = 240;

/** A tool-use block as its tool and one line of arguments; the block's text is `Name {json}`. */
export function callOf(b: Block): { name: string; args: string } {
  const space = b.text.indexOf(' ');
  const name = b.tool || (space < 0 ? b.text : b.text.slice(0, space));
  const raw = space < 0 ? '' : b.text.slice(space + 1);
  let args = raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const main = MAIN_ARGS.find((k) => typeof parsed[k] === 'string');
    if (main) args = String(parsed[main]);
  } catch { /* not JSON, or cut short: shown as written */ }
  const line = args.replace(/\s+/g, ' ').trim();
  return { name, args: line.length > CALL_CHARS ? `${line.slice(0, CALL_CHARS)}…` : line };
}

/** The call a tool result answers, found among the blocks around it, as one line. */
export function callLine(result: Block, around: readonly Block[]): string {
  if (result.call) return `${result.call.name} ${result.call.resource}`.trim();
  const use = around.find((b) => b.kind === 'tool_use' && b.callId !== '' && b.callId === result.callId);
  if (!use) return result.tool || 'Tool result';
  const c = callOf(use);
  return `${c.name} ${c.args}`.trim();
}

/** A step's input as the page shows it. */
export interface InputView {
  /** Blocks earlier requests already had, oldest first, as far as they are read. */
  earlier: Block[];
  /** Blocks new in this request, oldest first, as far as they are read. */
  fresh: Block[];
  /** How many blocks earlier requests already had. */
  earlierTotal: number;
  /** Blocks of the input not read yet; they are older than every block read. */
  unread: number;
}

/**
 * Splits what is read of a step's input, which arrives latest first. When older blocks are still
 * unread, the oldest read blocks of a message cut in two wait for the rest of it.
 */
export function inputView(latestFirst: readonly Block[], total: number, fresh: number): InputView {
  const unread = Math.max(0, total - latestFirst.length);
  const read = [...latestFirst].reverse();
  const cutAt = unread > 0 && read.length > 0 && read.some((b) => b.apiMsg !== read[0]!.apiMsg) ? read.findIndex((b) => b.apiMsg !== read[0]!.apiMsg) : 0;
  const whole = read.slice(cutAt);
  const freshCount = Math.min(fresh, whole.length);
  return { earlier: whole.slice(0, whole.length - freshCount), fresh: whole.slice(whole.length - freshCount), earlierTotal: Math.max(0, total - fresh), unread };
}

/** Characters of a long text shown before "Show all". */
export const CLAMP_CHARS = 2000;

/** The start of a long text and how much of it is hidden. */
export function clamp(textValue: string, open: boolean): { shown: string; hidden: number } {
  if (open || textValue.length <= CLAMP_CHARS) return { shown: textValue, hidden: 0 };
  return { shown: textValue.slice(0, CLAMP_CHARS), hidden: textValue.length - CLAMP_CHARS };
}
