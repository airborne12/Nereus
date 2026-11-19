// An independent computation for the sequence and rule tests on Doris (spec 11). The events are read back
// with a plain statement and matched here by a loop. What an input or a reply says is taken from
// the transcript files themselves, not from the stored blocks, so a text that the import lost or
// attached to the wrong event shows as a difference.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Doris } from '../src/db/doris.ts';
import type { Step, StepKind } from '../src/semantics/sequences/pattern.ts';

export interface Ev { session_id: string; seq: number; ts: string; turn: number; kind: StepKind; name: string; status: string; target: string }
/** What a session says in its transcript, in order: the user's inputs and the texts of the replies that end a turn. `sub`: a sub-agent's. */
export interface Spoken { inputs: string[]; replies: string[]; sub: boolean }

const KIND: Record<string, StepKind> = { tool_call: 'call', user_input: 'user', compaction: 'compaction', llm_call: 'reply' };

function spokenIn(file: string, sub: boolean): Spoken {
  const rows = readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; }
  });
  const inputs = rows.filter((r) => r.type === 'user' && typeof r.message?.content === 'string' && !r.isCompactSummary).map((r) => String(r.message.content));
  // A reply is one API message that ended its turn; its rows carry one block each.
  const ended = rows.filter((r) => r.type === 'assistant' && r.message?.stop_reason === 'end_turn');
  const replies = [...new Set(ended.map((r) => String(r.message.id)))].map((id) =>
    ended.filter((r) => r.message.id === id).flatMap((r) => (r.message.content as any[]).filter((c) => c.type === 'text').map((c) => String(c.text))).join('\n'));
  return { inputs, replies, sub };
}

/** What every session written under `dir` says: main sessions in `dir`, sub-agents in `<session>/subagents`. */
export function spoken(dir: string): Map<string, Spoken> {
  const files = readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name.endsWith('.jsonl')) return [path];
    const sub = join(path, 'subagents');
    return statSync(path).isDirectory() && statSync(sub, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(sub).filter((n) => n.endsWith('.jsonl')).map((n) => join(sub, n)) : [];
  });
  return new Map(files.map((f) => [basename(f, '.jsonl'), spokenIn(f, basename(dirname(f)) === 'subagents')]));
}

/** The events of every session in order. A call's target comes from its event; an input's and a reply's from the transcript. */
export async function readEvents(doris: Doris, db: string, said: ReadonlyMap<string, Spoken>): Promise<Ev[]> {
  const rows = (await doris.query(`SELECT session_id, seq, ts, turn, kind, name, status, resource, CAST(args AS STRING) AS args, stop_reason FROM ${db}.agent_events ORDER BY session_id, seq`))
    .filter((e) => e.kind === 'user_input' || e.kind === 'tool_call' || e.kind === 'compaction' || (e.kind === 'llm_call' && e.stop_reason === 'end_turn'));
  const sessions = [...new Set(rows.map((e) => String(e.session_id)))];
  return sessions.flatMap((id) => {
    const mine = rows.filter((e) => e.session_id === id);
    const words = said.get(id);
    const inputs = mine.filter((e) => e.kind === 'user_input');
    const replies = mine.filter((e) => e.kind === 'llm_call');
    if (!words || words.inputs.length !== inputs.length || words.replies.length !== replies.length) throw new Error(`the transcript of ${id} does not line up with its events`);
    return mine.map((e): Ev => {
      const target = e.kind === 'tool_call' ? String(e.resource ?? e.args ?? '') : e.kind === 'compaction' ? ''
        : e.kind === 'user_input' ? words.inputs[inputs.indexOf(e)]! : words.replies[replies.indexOf(e)]!;
      return { session_id: id, seq: Number(e.seq), ts: String(e.ts), turn: Number(e.turn), kind: KIND[String(e.kind)]!, name: String(e.name ?? ''), status: String(e.status ?? ''), target };
    });
  });
}

/** The events grouped per session, in order. */
export function bySession(events: readonly Ev[]): Ev[][] {
  return [...new Set(events.map((e) => e.session_id))].map((id) => events.filter((e) => e.session_id === id));
}

/** A step as the loop reads it; a step of a rule names whole words of a command. */
export type LoopStep = Omit<Step, 're'> & { words?: readonly string[] };

/** Whether a lower-case text holds one of the words as a word of its own, found by a loop over its places. */
export function holdsWord(text: string, words: readonly string[]): boolean {
  return words.some((w) => {
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) {
      const before = i > 0 ? text[i - 1]! : ' ';
      const after = text[i + w.length] ?? ' ';
      if (!/[a-z0-9_./-]/.test(before) && !/[a-z0-9_]/.test(after)) return true;
    }
    return false;
  });
}

export const meets = (s: LoopStep, e: Ev, taken: readonly Ev[]): boolean => s.kind === e.kind
  && (!s.tool || e.name === s.tool)
  && (!s.status || e.status === (s.status === 'failed' ? 'error' : 'ok'))
  && (!s.has || e.target.toLowerCase().includes(s.has))
  && (!s.any || s.any.some((w) => e.target.toLowerCase().includes(w)))
  && (!s.words || holdsWord(e.target.toLowerCase(), s.words))
  && (!s.same || (e.target !== '' && e.target === taken[s.same - 1]!.target));

/** The matches in one session: every event that meets step 1 starts at most one, each further step takes the nearest event. */
export function find(pattern: readonly LoopStep[], events: readonly Ev[]): { taken: Ev[]; span: number }[] {
  return events.flatMap((first, at) => {
    if (!meets(pattern[0]!, first, [])) return [];
    const taken = [first];
    const where = [at];
    for (let j = 1; j < pattern.length; j += 1) {
      const from = where[j - 1]! + 1;
      const end = pattern[j]!.link === 'next' ? Math.min(from + 1, events.length) : events.length;
      let hit = -1;
      for (let i = from; i < end && hit < 0; i += 1) if (meets(pattern[j]!, events[i]!, taken)) hit = i;
      if (hit < 0) return [];
      taken.push(events[hit]!);
      where.push(hit);
    }
    return [{ taken, span: where[where.length - 1]! - where[0]! + 1 }];
  });
}
