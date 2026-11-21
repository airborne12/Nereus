// The Memories pages as data (spec 8.8): a memory's address, its state and its source in words, and
// where each agent keeps each field. An inferred source is always said to be inferred, with its score.

import type { Row } from '../../api/agents.ts';
import { plural, text } from './format.ts';

export interface MemoryRef { agent: string; scope: string; name: string }

export const memoryUrl = (r: MemoryRef): string =>
  `/agents/memories/${encodeURIComponent(r.agent)}/${encodeURIComponent(r.scope)}/${encodeURIComponent(r.name)}`;

/** The memory an address names; null when it names none or is not encoded well. */
export function memoryPath(path: string): MemoryRef | null {
  const m = /^\/agents\/memories\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m) return null;
  try {
    return { agent: decodeURIComponent(m[1]!), scope: decodeURIComponent(m[2]!), name: decodeURIComponent(m[3]!) };
  } catch {
    return null;
  }
}

const STATES: Record<string, string> = {
  unjudged: 'Not judged yet', unused: 'Not used since written', unrecorded: 'Use not recorded', removed: 'Removed',
  holds: 'Holds', doubt: 'In doubt', outdated: 'Out of date',
};

/** A memory's state in words. */
export const stateLabel = (s: unknown): string => STATES[text(s)] ?? STATES.unjudged!;
export const stateTone = (s: unknown): 'ok' | 'warn' | 'bad' | 'dim' => (s === 'holds' ? 'ok' : s === 'doubt' ? 'warn' : s === 'outdated' ? 'bad' : 'dim');

const EVIDENCE: Record<string, string> = { supports: 'Supports', conflicts: 'Conflicts', none: 'No bearing' };
/** What a session that read a memory was to it, in words; an update without evidence is a call that gave no judgment. */
export const evidenceLabel = (e: unknown): string => EVIDENCE[text(e)] ?? 'No judgment';

/** Which judge gave a memory's state and the model of its last update, from its updates newest first; null before the first. */
export function judgedBy(history: readonly Row[]): string | null {
  const last = history.find((h) => h.state !== null && h.state !== undefined) ?? history[0];
  if (!last) return null;
  return `Judged by the validity judge, version ${text(last.judge_version)}, in ${plural(history.length, 'update')}; the last with ${text(last.model)}.`;
}

/** What a state means for a memory of `agent`. */
export function stateNote(state: unknown, agent: string): string {
  if (state === 'holds') return 'The validity judge found no session that read it since it was written to show it wrong.';
  if (state === 'doubt') return 'The validity judge found evidence against it in a session that read it, not enough to settle it.';
  if (state === 'outdated') return 'The validity judge found that a session that read it shows it no longer holds; the agent or a person should revise it.';
  if (state === 'unrecorded') return `${agent} loads it whole into every session, so which sessions used it is not recorded.`;
  if (state === 'unused') return 'No session has read it since it was last written.';
  if (state === 'removed') return 'It was no longer in its store when it was last captured.';
  return 'A session has read it since it was last written; no judge has said yet whether it still holds.';
}

/** A memory's source as a page shows it: the text, and the session it opens when there is one. */
export interface SourceView { text: string; root: string | null; session: string | null; inferred: boolean }

export function sourceOf(row: Row): SourceView {
  const session = text(row.source_session_id) || null;
  const root = text(row.source_root_id) || null;
  if (row.source_kind === 'recorded' && session) return { text: text(row.source_title) || `Session ${session.slice(0, 8)}`, root, session, inferred: false };
  if (row.source_kind === 'inferred' && session) return { text: `inferred · ${Math.round(Number(row.source_score) * 100)} % of words`, root, session, inferred: true };
  return { text: 'Not recorded', root: null, session: null, inferred: false };
}

/** Where an agent keeps a field of a memory of `format`. */
export interface Kept { field: 'name' | 'description' | 'kind' | 'updated_at' | 'source' | 'content'; where: string }

const KEPT: Record<string, Kept[]> = {
  'claude-auto-memory': [
    { field: 'name', where: 'name in the frontmatter, else the file name' },
    { field: 'description', where: 'description in the frontmatter' },
    { field: 'kind', where: 'metadata.type in the frontmatter' },
    { field: 'updated_at', where: 'metadata.modified in the frontmatter, else the time of the file' },
    { field: 'source', where: 'metadata.originSessionId in the frontmatter' },
    { field: 'content', where: 'the file after its frontmatter, by its own headings' },
  ],
  'gemini-md': [
    { field: 'name', where: 'the first 200 characters of the bullet' },
    { field: 'updated_at', where: 'the time of the GEMINI.md file' },
    { field: 'content', where: 'a bullet under "## Gemini Added Memories" in GEMINI.md' },
  ],
};

export const whereKept = (format: string): Kept[] => KEPT[format] ?? [];
