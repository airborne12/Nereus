// Source inference and the statements of memory capture: the words a memory is matched by, the
// statement that finds the session it most likely came from, and the rows a capture writes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryRecord } from '../src/semantics/memories/model.ts';
import { INFER_SHARE, inferSourceSql, MAX_WORDS, MIN_WORDS, memoryWords, sourceOf } from '../src/semantics/memories/source.ts';
import { memoryRow, removedRow, storeVersionsSql } from '../src/semantics/memories/statements.ts';

const memory = (extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
  agent: 'claude-code', scope: '-home-u-work', name: 'build-cache-flag', format: 'claude-auto-memory', location: '/home/u/.claude/projects/-home-u-work/memory/build-cache-flag.md',
  description: 'The build reuses its cache only with the keep flag', kind: 'feedback',
  content: 'Run make with the keep flag.\n\n## Why\nA clean build takes forty minutes.',
  sections: [{ heading: null, text: 'Run make with the keep flag.' }, { heading: 'Why', text: 'A clean build takes forty minutes.' }],
  fields: { name: 'build-cache-flag' }, content_hash: 'a'.repeat(64), updated_at: '2026-11-11 00:17:09.197000', source_session_id: null, source_kind: 'none', ...extra,
});

test("a memory's words: its description and sections, without common words, headings or short words, at most forty", () => {
  assert.deepEqual(memoryWords(memory()), ['build', 'reuses', 'cache', 'only', 'keep', 'flag', 'make', 'clean', 'takes', 'forty', 'minutes']);
  assert.ok(!memoryWords(memory()).includes('why'), 'a heading is not a word of the memory');
  const many = memory({ description: null, sections: [{ heading: null, text: Array.from({ length: 60 }, (_, i) => `word${i}x`).join(' ') }] });
  assert.equal(memoryWords(many).length, MAX_WORDS);
  assert.deepEqual(memoryWords(memory({ description: null, sections: [], content: 'Use pnpm, not npm, in this repository: 日本語のメモ' })), ['pnpm', 'repository']);
  assert.deepEqual([MIN_WORDS, MAX_WORDS, INFER_SHARE], [5, 40, 0.5]);
});

test('the statement that finds the session a memory most likely came from: sessions of the same agent before the memory, by words found', () => {
  const words = ['build', 'cache', 'keep', 'flag', 'forty'];
  const s = inferSourceSql('otel', memory(), words);
  assert.equal(s.title, 'Source of the memory');
  assert.match(s.sql, /FROM otel\.agent_sessions s\n {2}WHERE s\.kind = 'main' AND s\.runtime = 'claude-code' AND s\.started_at < '2026-11-11 00:17:09\.197000' AND s\.first_input MATCH_ANY 'build cache keep flag forty'/);
  assert.match(s.sql, /FROM otel\.agent_messages m\n {2}JOIN otel\.agent_sessions s ON s\.session_id = m\.session_id\n {2}WHERE s\.kind = 'main' AND s\.runtime = 'claude-code' AND s\.started_at < '2026-11-11 00:17:09\.197000' AND m\.msg_role = 'assistant' AND m\.kind = 'text' AND m\.text MATCH_ANY 'build cache keep flag forty'/);
  assert.match(s.sql, /max\(if\(regexp\(t, '\(\^\|\[\^a-z0-9_\]\)build\(\[\^a-z0-9_\]\|\$\)'\), 1, 0\)\) \+ max\(if\(regexp\(t, '\(\^\|\[\^a-z0-9_\]\)cache/);
  assert.match(s.sql, /GROUP BY session_id\nORDER BY found DESC, session_id\nLIMIT 1$/);
  assert.throws(() => inferSourceSql('otel', memory(), ["x' OR 1=1"]), /not a word/);
});

test('a session found for more than half of the words is the inferred source, with its share; else none', () => {
  const words = ['a1aa', 'b2bb', 'c3cc', 'd4dd', 'e5ee', 'f6ff'];
  assert.deepEqual(sourceOf([{ session_id: 's-1', found: 4 }], words), { source_session_id: 's-1', source_kind: 'inferred', source_score: 0.667 });
  assert.deepEqual(sourceOf([{ session_id: 's-1', found: 3 }], words), { source_session_id: null, source_kind: 'none', source_score: null }, 'half is not more than half');
  assert.deepEqual(sourceOf([], words), { source_session_id: null, source_kind: 'none', source_score: null });
});

test('the latest version of each memory of a store, and the rows a capture writes', () => {
  assert.equal(storeVersionsSql('otel', 'claude-code', '-home-u-work').sql, [
    'SELECT name, max_by(content_hash, captured_at) AS content_hash, max_by(location, captured_at) AS location, max_by(format, captured_at) AS format',
    'FROM otel.agent_memories',
    "WHERE agent = 'claude-code' AND scope = '-home-u-work'",
    'GROUP BY name',
  ].join('\n'));
  const at = '2026-11-19 10:00:00.000000';
  assert.deepEqual(memoryRow(memory(), at, { source_session_id: 's-1', source_kind: 'inferred', source_score: 0.6 }), {
    agent: 'claude-code', scope: '-home-u-work', name: 'build-cache-flag', captured_at: at, format: 'claude-auto-memory', location: memory().location,
    description: memory().description, kind: 'feedback', content: memory().content, sections: memory().sections, fields: { name: 'build-cache-flag' },
    content_hash: 'a'.repeat(64), updated_at: '2026-11-11 00:17:09.197000', source_session_id: 's-1', source_kind: 'inferred', source_score: 0.6,
  });
  assert.deepEqual(removedRow({ agent: 'claude-code', scope: '-home-u-work', name: 'old', location: '/x/old.md', format: 'claude-auto-memory' }, at), {
    agent: 'claude-code', scope: '-home-u-work', name: 'old', captured_at: at, format: 'claude-auto-memory', location: '/x/old.md',
    description: null, kind: null, content: null, sections: null, fields: null, content_hash: 'removed', updated_at: at, source_session_id: null, source_kind: null, source_score: null,
  });
});
