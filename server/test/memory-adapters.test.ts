// The memory adapters on memory files written by hand: the frontmatter, a Claude Code auto memory
// with its recorded source, the index that is not a memory, and the bullets Gemini CLI adds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readClaudeMemory } from '../src/semantics/memories/claude-memory.ts';
import { parseFrontmatter, sectionsOf } from '../src/semantics/memories/frontmatter.ts';
import { readGeminiMemories } from '../src/semantics/memories/gemini-memory.ts';

const CLAUDE = [
  '---',
  'name: build-cache-flag',
  'description: "The build reuses its cache only with --keep: say so before a clean build"',
  'metadata:',
  '  node_type: memory',
  '  type: feedback',
  '  originSessionId: 0f3c9a12-7d4e-4b8a-9c21-6e5f4d3b2a10',
  '  modified: 2026-11-11T00:17:09.197Z',
  'tags:',
  '  - build',
  "  - 'cache'",
  '---',
  '',
  'Run `make` with --keep to reuse the cache.',
  '',
  '## Why',
  'A clean build takes forty minutes.',
  '',
  '```sh',
  '# not a heading inside a fence',
  '```',
  '## How to apply',
  'Ask before a clean build.',
].join('\n');

test('a frontmatter of keys, quoted values, nested maps and lists', () => {
  const { fields, body } = parseFrontmatter(CLAUDE);
  assert.deepEqual(fields, {
    name: 'build-cache-flag', description: 'The build reuses its cache only with --keep: say so before a clean build',
    metadata: { node_type: 'memory', type: 'feedback', originSessionId: '0f3c9a12-7d4e-4b8a-9c21-6e5f4d3b2a10', modified: '2026-11-11T00:17:09.197Z' },
    tags: ['build', 'cache'],
  });
  assert.ok(body.startsWith('Run `make`'));
  assert.deepEqual(parseFrontmatter('No frontmatter here.'), { fields: {}, body: 'No frontmatter here.' });
  assert.deepEqual(parseFrontmatter('---\nname: x\nno closing line'), { fields: {}, body: '---\nname: x\nno closing line' }, 'an unclosed frontmatter is body');
});

test('a body is split by its own headings, not by lines inside a code fence', () => {
  assert.deepEqual(sectionsOf(parseFrontmatter(CLAUDE).body), [
    { heading: null, text: 'Run `make` with --keep to reuse the cache.' },
    { heading: 'Why', text: 'A clean build takes forty minutes.\n\n```sh\n# not a heading inside a fence\n```' },
    { heading: 'How to apply', text: 'Ask before a clean build.' },
  ]);
});

test('a Claude Code auto memory: its name, kind, time and recorded source come from its frontmatter', () => {
  const path = '/home/u/.claude/projects/-home-u-work/memory/build-cache-flag.md';
  const m = readClaudeMemory(path, CLAUDE, Date.parse('2026-11-12T08:00:00Z'))!;
  assert.deepEqual([m.agent, m.scope, m.name, m.format, m.location, m.kind], ['claude-code', '-home-u-work', 'build-cache-flag', 'claude-auto-memory', path, 'feedback']);
  assert.equal(m.description, 'The build reuses its cache only with --keep: say so before a clean build');
  assert.equal(m.updated_at, '2026-11-11 00:17:09.197000');
  assert.deepEqual([m.source_session_id, m.source_kind], ['0f3c9a12-7d4e-4b8a-9c21-6e5f4d3b2a10', 'recorded']);
  assert.equal(m.sections.length, 3);
  assert.match(m.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(readClaudeMemory(path, `${CLAUDE}\n`, 0)!.content_hash, m.content_hash, 'a trailing new line is not a change');
  assert.notEqual(readClaudeMemory(path, CLAUDE.replace('forty', 'fifty'), 0)!.content_hash, m.content_hash);
});

test('a memory without metadata takes its name from the file and its time from the file; the index is not a memory', () => {
  const m = readClaudeMemory('/home/u/.claude/projects/-home-u-work/memory/plain-note.md', 'Just a note.', Date.parse('2026-11-12T08:00:00Z'))!;
  assert.deepEqual([m.name, m.kind, m.description, m.updated_at, m.source_session_id, m.source_kind], ['plain-note', null, null, '2026-11-12 08:00:00.000000', null, 'none']);
  assert.equal(readClaudeMemory('/home/u/.claude/projects/-home-u-work/memory/MEMORY.md', '- [A](a.md) — hook', 0), null);
  assert.equal(readClaudeMemory('/home/u/notes/x.md', 'Not in a memory folder.', 0), null);
});

const GEMINI = [
  '# Project notes',
  '',
  'Written by hand, not a memory.',
  '',
  '## Gemini Added Memories',
  '- The staging database is read-only on Fridays.',
  '- Use pnpm, not npm,',
  '  in this repository.',
  '* Tabs are two spaces wide.',
  '',
  '## Other',
  '- Not a memory either.',
].join('\n');

test('Gemini CLI: one memory per bullet under "## Gemini Added Memories", with no metadata', () => {
  const ms = readGeminiMemories('/home/u/.gemini/GEMINI.md', GEMINI, 'global', Date.parse('2026-11-12T08:00:00Z'));
  assert.deepEqual(ms.map((m) => [m.agent, m.scope, m.format, m.name, m.kind, m.source_kind]), [
    ['gemini-cli', 'global', 'gemini-md', 'The staging database is read-only on Fridays.', null, 'none'],
    ['gemini-cli', 'global', 'gemini-md', 'Use pnpm, not npm, in this repository.', null, 'none'],
    ['gemini-cli', 'global', 'gemini-md', 'Tabs are two spaces wide.', null, 'none'],
  ]);
  assert.deepEqual([ms[1]!.content, ms[1]!.description, ms[1]!.updated_at, ms[1]!.sections], ['Use pnpm, not npm, in this repository.', null, '2026-11-12 08:00:00.000000', []]);
  assert.deepEqual(readGeminiMemories('/home/u/p/GEMINI.md', '# Nothing added', '/home/u/p', 0), []);
  const long = `## Gemini Added Memories\n- ${'word '.repeat(80)}`;
  assert.equal(readGeminiMemories('/g', long, 'global', 0)[0]!.name.length, 200, 'a name is cut at 200 characters; the content keeps the whole bullet');
});
