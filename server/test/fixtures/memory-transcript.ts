// Sessions written by hand for the memories: one writes a memory file, a later one reads it and
// speaks of a subject another memory, whose source is not recorded, is about.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Call, sessionLines, type Turn } from './risk-transcript.ts';

/** The memory folder the sessions write to and read from, as the agent named it. */
export const MEMORY_DIR = '/home/u/.claude/projects/-home-u-work/memory';
export const BUILD_MEMORY = `${MEMORY_DIR}/build-cache-flag.md`;
export const WRITER_ID = 'fx-memory-0001';
export const READER_ID = 'fx-memory-0002';

const call = (tool: string, input: Record<string, unknown>): Call => ({ tool, input });
const WRITES: Turn[] = [
  {
    says: 'Remember that the build reuses its cache only with the keep flag',
    calls: [call('Write', { file_path: BUILD_MEMORY, content: 'Run make with --keep to reuse the cache.' })],
    reply: 'Saved a memory about the keep flag.',
  },
];
const READS: Turn[] = [
  {
    says: 'Why does the deploy pipeline take so long on the staging machines?',
    calls: [call('Read', { file_path: BUILD_MEMORY }), call('Bash', { command: 'make --keep' })],
    reply: 'The staging deploy pipeline waits for the artifact registry: the registry mirror on the staging machines is slow, and the pipeline uploads again after each timeout.',
  },
];

/** Writes the two sessions into `dir` and returns their files. */
export function writeMemorySessions(dir: string): string[] {
  return [[WRITER_ID, 'Remember the keep flag', '2026-11-17T12:00:00Z', WRITES], [READER_ID, 'Slow staging deploys', '2026-11-17T15:00:00Z', READS]].map(([id, title, start, turns]) => {
    const file = join(dir, `${id as string}.jsonl`);
    writeFileSync(file, `${sessionLines(id as string, title as string, start as string, turns as Turn[]).main.join('\n')}\n`);
    return file;
  });
}
