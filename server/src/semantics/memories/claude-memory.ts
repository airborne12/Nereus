// The Claude Code auto memory adapter (spec 6.5): a memory is a Markdown file in
// `~/.claude/projects/<project>/memory/`, with `name`, `description` and, under `metadata`, `type`,
// `originSessionId` and `modified`. `MEMORY.md` is the index of the folder, not a memory.

import { dorisTime } from '../trajectory/model.ts';
import { parseFrontmatter, sectionsOf } from './frontmatter.ts';
import { type MemoryRecord, memoryHash } from './model.ts';

const MEMORY_FILE = /\/projects\/([^/]+)\/memory\/([^/]+)\.md$/;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The memory in a file of a project's memory folder; null for the index or a file outside such a folder. */
export function readClaudeMemory(location: string, text: string, mtimeMs: number): MemoryRecord | null {
  const at = MEMORY_FILE.exec(location);
  if (!at || at[2] === 'MEMORY') return null;
  const { fields, body } = parseFrontmatter(text);
  const meta = obj(fields.metadata);
  const field = (key: string): string | null => str(meta[key]) ?? str(fields[key]);
  const content = body.trim();
  const modified = field('modified');
  const time = modified && Number.isFinite(Date.parse(modified)) ? modified : new Date(mtimeMs).toISOString();
  const origin = field('originSessionId');
  return {
    agent: 'claude-code', scope: at[1]!, name: str(fields.name) ?? at[2]!, format: 'claude-auto-memory', location,
    description: str(fields.description), kind: field('type'), content, sections: sectionsOf(content), fields,
    content_hash: memoryHash(fields, content), updated_at: dorisTime(time),
    source_session_id: origin, source_kind: origin ? 'recorded' : 'none',
  };
}
