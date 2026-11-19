// The Claude Code auto memory adapter (spec 6.5): a memory is a Markdown file in a project's memory
// folder, `~/.claude/projects/<project>/memory/`, with `name`, `description` and, under
// `metadata`, `type`, `originSessionId` and `modified`. `MEMORY.md` is the index of the folder, not
// a memory. The reader of the folder gives the scope.

import { basename } from 'node:path';
import { dorisTime } from '../trajectory/model.ts';
import { parseFrontmatter, sectionsOf } from './frontmatter.ts';
import { cutBytes, KIND_BYTES, keyName, type MemoryRecord, memoryHash, SESSION_BYTES } from './model.ts';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The memory in a Markdown file of a memory folder of `scope`; null for the index. */
export function readClaudeMemory(scope: string, location: string, text: string, mtimeMs: number): MemoryRecord | null {
  const file = basename(location, '.md');
  if (file === 'MEMORY') return null;
  const { fields, body, raw } = parseFrontmatter(text);
  const meta = obj(fields.metadata);
  const field = (key: string): string | null => str(meta[key]) ?? str(fields[key]);
  const content = body.trim();
  const modified = field('modified');
  const time = modified && Number.isFinite(Date.parse(modified)) ? modified : new Date(mtimeMs).toISOString();
  const kind = field('type');
  // An id longer than a session id can be is not one.
  const origin = field('originSessionId');
  const session = origin && Buffer.byteLength(origin) <= SESSION_BYTES ? origin : null;
  return {
    agent: 'claude-code', scope, name: keyName(str(fields.name) ?? file), format: 'claude-auto-memory', location,
    description: str(fields.description), kind: kind === null ? null : cutBytes(kind, KIND_BYTES), content, sections: sectionsOf(content), fields,
    content_hash: memoryHash(raw, content), updated_at: dorisTime(time),
    source_session_id: session, source_kind: session ? 'recorded' : 'none',
  };
}
