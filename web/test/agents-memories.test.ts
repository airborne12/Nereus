// The Memories pages as data: a memory's address, its state and source in words (an inferred source
// is never shown as recorded), where its agent keeps each field, and the table of memories.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceLabel, memoryPath, memoryUrl, sourceOf, stateLabel, stateNote, stateTone, whereKept } from '../src/lib/agents/memories.ts';
import { MEMORIES, PAGES, rowKey, SESSION_PAGES } from '../src/lib/agents/pages.ts';
import { parseTableState, serializeTableState } from '../src/lib/agents/table.ts';

test("a memory's address names its agent, scope and name, each encoded, and is read back", () => {
  const ref = { agent: 'gemini-cli', scope: '/home/u/my project', name: 'Use pnpm, not npm / yarn?' };
  const url = memoryUrl(ref);
  assert.equal(url, '/agents/memories/gemini-cli/%2Fhome%2Fu%2Fmy%20project/Use%20pnpm%2C%20not%20npm%20%2F%20yarn%3F');
  assert.deepEqual(memoryPath(url), ref);
  assert.equal(memoryPath('/agents/memories/a/b'), null);
  assert.equal(memoryPath('/agents/memories/a/%E0%A4%A/c'), null, 'an address that is not encoded well names no memory');
});

test('a state in words, with its tone and what it means', () => {
  assert.deepEqual(['unjudged', 'unused', 'unrecorded', 'removed', 'holds', 'doubt', 'outdated', undefined].map(stateLabel),
    ['Not judged yet', 'Not used since written', 'Use not recorded', 'Removed', 'Holds', 'In doubt', 'Out of date', 'Not judged yet']);
  assert.deepEqual(['holds', 'doubt', 'outdated', 'unused'].map(stateTone), ['ok', 'warn', 'bad', 'dim']);
  assert.equal(stateNote('unrecorded', 'gemini-cli'), 'gemini-cli loads it whole into every session, so which sessions used it is not recorded.');
  assert.equal(stateNote('unused', 'claude-code'), 'No session has read it since it was last written.');
});

test('a source in words: a recorded session, an inferred one with its share of words, or none; never inferred as recorded', () => {
  assert.deepEqual(sourceOf({ source_kind: 'recorded', source_session_id: '0f3c9a12-7d4e-4b8a', source_root_id: '0f3c9a12-7d4e-4b8a', source_title: 'Speed up the build', source_score: null }),
    { text: 'Speed up the build', root: '0f3c9a12-7d4e-4b8a', session: '0f3c9a12-7d4e-4b8a', inferred: false });
  assert.equal(sourceOf({ source_kind: 'recorded', source_session_id: '0f3c9a12-7d4e-4b8a', source_root_id: '0f3c9a12-7d4e-4b8a', source_title: null, source_score: null }).text, 'Session 0f3c9a12', 'a session without a title is named by its id');
  assert.deepEqual(sourceOf({ source_kind: 'inferred', source_session_id: 'agent-a1', source_root_id: 's-9', source_title: 'A title', source_score: 0.667 }),
    { text: 'inferred · 67 % of words', root: 's-9', session: 'agent-a1', inferred: true });
  assert.deepEqual(sourceOf({ source_kind: 'none', source_session_id: null, source_root_id: null, source_score: null }), { text: 'Not recorded', root: null, session: null, inferred: false });
  assert.deepEqual(sourceOf({ source_kind: 'recorded', source_session_id: 'gone', source_root_id: null, source_score: null }),
    { text: 'Session gone', root: null, session: 'gone', inferred: false }, 'a recorded session that was not imported is named, not linked');
});

test('where each agent keeps each field', () => {
  assert.deepEqual(whereKept('claude-auto-memory').map((w) => w.field), ['name', 'description', 'kind', 'updated_at', 'source', 'content']);
  assert.equal(whereKept('claude-auto-memory').find((w) => w.field === 'source')!.where, 'metadata.originSessionId in the frontmatter');
  assert.deepEqual(whereKept('gemini-md').map((w) => [w.field, w.where]), [
    ['name', 'the first 200 characters of the bullet'], ['updated_at', "the time of the GEMINI.md file"], ['content', 'a bullet under "## Gemini Added Memories" in GEMINI.md'],
  ]);
  assert.deepEqual(whereKept('else'), []);
});

test('Memories is a table of its own, not a sibling of the Sessions pages; its rows are keyed by memory', () => {
  assert.deepEqual(MEMORIES.columns.filter((c) => c.shown).map((c) => c.label), ['Updated', 'Agent', 'Scope', 'Memory', 'Kind', 'Still valid', 'Source session']);
  assert.equal(MEMORIES.defaultSort, 'updated_at');
  assert.equal(PAGES.memories, MEMORIES);
  assert.deepEqual(SESSION_PAGES.map((p) => p.name), ['sessions', 'steps', 'messages', 'risks']);
  assert.equal(rowKey(MEMORIES, { agent: 'a', scope: 's', name: 'n' }), 'a\ns\nn');
  assert.equal(rowKey(PAGES.steps, { session_id: 's', seq: 4 }), 's:4');
});

test('Memories opens on the past 30 days, since a memory is updated seldom; the other pages keep 7 days', () => {
  assert.deepEqual(parseTableState('', MEMORIES).range, { preset: '30d' });
  assert.deepEqual(parseTableState('', PAGES.sessions).range, { preset: '7d' });
  const at = (preset: '7d' | '30d') => ({ ...parseTableState('', MEMORIES), range: { preset } });
  assert.deepEqual([serializeTableState(at('30d'), MEMORIES), serializeTableState(at('7d'), MEMORIES)], ['', '?t=7d']);
  assert.equal(serializeTableState({ ...parseTableState('', PAGES.sessions), range: { preset: '30d' } }, PAGES.sessions), '?t=30d');
});

test('what the validity fold found in words: the evidence of a session, and what each state means', () => {
  assert.deepEqual(['supports', 'conflicts', 'none', 'else'].map(evidenceLabel), ['Supports', 'Conflicts', 'No bearing', 'No bearing']);
  assert.equal(stateNote('holds', 'claude-code'), 'The sessions that read it since it was written bear it out.');
  assert.equal(stateNote('doubt', 'claude-code'), 'A session that read it gave evidence against it that does not settle it.');
  assert.equal(stateNote('outdated', 'claude-code'), 'A session that read it showed it no longer holds; the agent or a person should revise it.');
  assert.deepEqual(MEMORIES.columns.find((c) => c.name === 'still_valid')!.values, ['holds', 'doubt', 'outdated', 'unjudged', 'unused', 'unrecorded']);
});
