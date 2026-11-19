// The command that captures memories: the stores it reads from a Claude Code projects folder and
// from GEMINI.md files written by hand into a temporary folder, its options, and what it prints.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseArgs, readClaudeStores, readGeminiStore, summary } from '../src/cli/capture-memories.ts';

const dir = mkdtempSync(join(tmpdir(), 'nereus-memories-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('a store per project memory folder, an empty one included so that its removals are seen; the index is skipped', async () => {
  const projects = join(dir, 'projects');
  mkdirSync(join(projects, '-home-u-a', 'memory'), { recursive: true });
  mkdirSync(join(projects, '-home-u-b', 'memory'), { recursive: true });
  mkdirSync(join(projects, '-home-u-c'), { recursive: true });
  writeFileSync(join(projects, '-home-u-a', 'memory', 'one.md'), '---\nname: one\ndescription: First\n---\nBody one.');
  writeFileSync(join(projects, '-home-u-a', 'memory', 'two.md'), 'Body two.');
  writeFileSync(join(projects, '-home-u-a', 'memory', 'MEMORY.md'), '- [One](one.md)');
  writeFileSync(join(projects, '-home-u-a', 'memory', 'notes.txt'), 'not markdown');
  const stores = await readClaudeStores(projects, 'u@h', true);
  assert.deepEqual(stores.map((s) => [s.agent, s.scope, s.memories.map((m) => m.name)]), [['claude-code', 'u@h:-home-u-a', ['one', 'two']], ['claude-code', 'u@h:-home-u-b', []]]);
  assert.deepEqual(await readClaudeStores(join(dir, 'nowhere'), 'u@h', false), [], 'a default folder that is missing has no store');
  await assert.rejects(readClaudeStores(join(dir, 'nowhere'), 'u@h', true), /no such folder/, 'a named folder that is missing fails');
});

test('a GEMINI.md is one store of its scope; a missing file is none', async () => {
  const file = join(dir, 'GEMINI.md');
  writeFileSync(file, '## Gemini Added Memories\n- Use pnpm here.\n- Fridays are read-only.\n');
  const store = await readGeminiStore(file, 'u@h:global');
  assert.deepEqual([store?.agent, store?.scope, store?.memories.map((m) => m.content)], ['gemini-cli', 'u@h:global', ['Use pnpm here.', 'Fridays are read-only.']]);
  assert.equal(await readGeminiStore(join(dir, 'missing.md'), 'u@h:global'), null);
});

const HOST = { home: '/home/u', cwd: '/work', owner: 'u@h' };

test('the options: folders and GEMINI.md files, resolved, an owner, --reinfer, and the defaults in the home folder', () => {
  assert.deepEqual(parseArgs([], HOST), { claude: ['/home/u/.claude/projects'], gemini: [{ file: '/home/u/.gemini/GEMINI.md', scope: 'global' }], owner: 'u@h', reinfer: false, named: false });
  assert.deepEqual(parseArgs(['--claude', 'copies/projects', '--gemini', '/p/GEMINI.md=/p', '--gemini', '/g/GEMINI.md', '--owner', 'ada', '--reinfer'], HOST), {
    claude: ['/work/copies/projects'], gemini: [{ file: '/p/GEMINI.md', scope: '/p' }, { file: '/g/GEMINI.md', scope: 'global' }], owner: 'ada', reinfer: true, named: true,
  });
  assert.deepEqual(parseArgs(['--reinfer'], HOST).claude, ['/home/u/.claude/projects'], 'an option that names no folder keeps the defaults');
  assert.throws(() => parseArgs(['--claude'], HOST), /--claude needs a folder/);
  assert.throws(() => parseArgs(['--else'], HOST), /unknown option --else/);
});

test('a memory folder that cannot be read fails, rather than making an empty store whose memories would be marked removed', async () => {
  const projects = join(dir, 'locked');
  mkdirSync(join(projects, '-home-u-x', 'memory'), { recursive: true });
  chmodSync(join(projects, '-home-u-x', 'memory'), 0o000);
  try {
    await assert.rejects(readClaudeStores(projects, 'u@h', true), /cannot read/);
  } finally {
    chmodSync(join(projects, '-home-u-x', 'memory'), 0o755);
  }
});

test('one line for the pass, one per store that failed', () => {
  assert.deepEqual(summary({ stores: 3, written: 4, removed: 1, unchanged: 20, inferred: 2, reinferred: 3, held: 1, failed: [{ store: 'claude-code/p', error: 'Doris is down' }] }), [
    '3 store(s): 4 version(s) written, 1 removed, 20 unchanged; 2 source(s) inferred; 3 inferred again; 1 store(s) left to another runner',
    'store claude-code/p failed: Doris is down',
  ]);
});
