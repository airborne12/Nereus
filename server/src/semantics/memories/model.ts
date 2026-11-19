// A memory as the adapters read it (spec 5.9): one version of one memory of one agent, before it is
// captured. Its key is the agent, the scope it applies to and its name.

import { sha256 } from '../trajectory/hash.ts';
import type { Section } from './frontmatter.ts';

/** Whether a memory's source session is recorded by the agent, inferred by Nereus, or unknown. */
export type SourceKind = 'recorded' | 'inferred' | 'none';

export interface MemoryRecord {
  agent: string;
  scope: string;
  name: string;
  /** The format it was read from, such as `claude-auto-memory`. */
  format: string;
  /** Where the agent keeps it: a path. */
  location: string;
  description: string | null;
  /** Its kind as the agent names it, such as `feedback`. */
  kind: string | null;
  content: string;
  sections: Section[];
  /** The format's own metadata, unchanged. */
  fields: Record<string, unknown>;
  content_hash: string;
  /** A Doris DATETIME(6) string: the format's time, or the file's. */
  updated_at: string;
  source_session_id: string | null;
  source_kind: SourceKind;
}

/** Formats whose reads are recorded as events, so that a memory's use can be seen and judged. */
export const READ_RECORDED = ['claude-auto-memory'] as const;

/** The hash of a memory's version: it changes when its content or its metadata as written does. */
export const memoryHash = (frontmatter: string, content: string): string => sha256(JSON.stringify({ frontmatter, content }));

/** The bytes the columns of agent_memories hold: a name, a kind, a session id, a scope. */
export const NAME_BYTES = 200;
export const KIND_BYTES = 32;
export const SESSION_BYTES = 128;
export const SCOPE_BYTES = 256;

/** The longest start of `text` that fits in `max` bytes of UTF-8, cut between characters. */
export function cutBytes(text: string, max: number): string {
  let used = 0;
  let out = '';
  for (const ch of text) {
    used += Buffer.byteLength(ch);
    if (used > max) break;
    out += ch;
  }
  return out;
}

/** A name that fits its column: as it is, or its start with 8 characters of the hash of the whole, so two long names that share their start stay apart. */
export function keyName(text: string): string {
  if (Buffer.byteLength(text) <= NAME_BYTES) return text;
  const tail = `… ${sha256(text).slice(0, 8)}`;
  return `${cutBytes(text, NAME_BYTES - Buffer.byteLength(tail))}${tail}`;
}
