// The Gemini CLI memory adapter (spec 6.5): `GEMINI.md` files keep what the agent was asked to
// remember as bullets under "## Gemini Added Memories", one memory per bullet, with no metadata.

import { dorisTime } from '../trajectory/model.ts';
import { keyName, type MemoryRecord, memoryHash } from './model.ts';

const ADDED = /^##\s+Gemini Added Memories\s*$/;
const BULLET = /^[-*]\s+(.*)$/;

/** The bullets of the section, a line indented under a bullet being part of it. */
function bulletsOf(lines: readonly string[]): string[] {
  const start = lines.findIndex((l) => ADDED.test(l.trim()));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).reduce<string[]>((bullets, line) => {
    const bullet = /^\S/.test(line) ? BULLET.exec(line) : null;
    if (bullet) return [...bullets, bullet[1]!];
    if (line.trim() && bullets.length) return [...bullets.slice(0, -1), `${bullets.at(-1)!} ${line.trim()}`];
    return bullets;
  }, []);
}

/** The memories of one `GEMINI.md`; `scope` is `global` for the user's own file, else the project's folder. */
export function readGeminiMemories(location: string, text: string, scope: string, mtimeMs: number): MemoryRecord[] {
  const at = dorisTime(new Date(mtimeMs).toISOString());
  return bulletsOf(text.split('\n')).map((raw) => {
    const content = raw.replace(/\s+/g, ' ').trim();
    return {
      agent: 'gemini-cli', scope, name: keyName(content), format: 'gemini-md', location, description: null, kind: null,
      content, sections: [], fields: {}, content_hash: memoryHash('', content), updated_at: at, source_session_id: null, source_kind: 'none',
    };
  });
}
