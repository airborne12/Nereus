// The memories API: one memory with its fields, sections, versions and the calls that used it. The
// Memories table is a table page like the others (`table('memories', …)` in agents.ts).

import type { Row, Statement } from './agents.ts';
import { get } from './http.ts';

export interface MemoryRef { agent: string; scope: string; name: string }
export interface Section { heading: string | null; text: string }

/** A captured version of a memory, without its content. */
export interface MemoryVersion {
  captured_at: string; updated_at: string | null; format: string | null; location: string | null; description: string | null; kind: string | null;
  content_hash: string; source_session_id: string | null; source_kind: string | null; source_score: number | null;
  source_root_id: string | null; source_title: string | null;
}
export interface MemoryAnswer {
  memory: MemoryVersion & MemoryRef & { content: string | null; sections: Section[]; fields: Record<string, unknown> };
  versions: MemoryVersion[];
  /** The calls that read or wrote its file, newest first. */
  uses: Row[];
  /** The updates the validity fold made to the state of its latest version, newest first; one without a state is a call that gave no judgment. */
  history: Row[];
  /** `holds`, `doubt` or `outdated` from the fold; else `unjudged`, `unused`, `unrecorded` or `removed`. */
  state: string;
  sql: Statement[];
  elapsedMs: number;
}

export const memory = (r: MemoryRef, signal?: AbortSignal) =>
  get<MemoryAnswer>(`/api/agents/memories/${encodeURIComponent(r.agent)}/${encodeURIComponent(r.scope)}/${encodeURIComponent(r.name)}`, {}, signal);
