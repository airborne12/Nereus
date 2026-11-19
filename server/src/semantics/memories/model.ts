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

/** The hash of a memory's version: it changes when its content or its metadata does. */
export const memoryHash = (fields: Record<string, unknown>, content: string): string => sha256(JSON.stringify({ fields, content }));
