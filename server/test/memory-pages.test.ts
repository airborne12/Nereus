// The memories as the pages read them: the Memories table (the latest version of each memory and
// whether it is still used), one memory with its versions and the calls that read or wrote it, and
// the memories a session tree wrote.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoriesPage, memorySql, memoryState, wroteSql } from '../src/semantics/memories/pages.ts';
import { tableSql } from '../src/semantics/trajectory/query.ts';

const REQ = { from: '2026-11-01T00:00:00Z', to: '2026-11-20T00:00:00Z', q: '', conditions: [], limit: 100, offset: 0 };

test('the Memories table: the latest version of each memory not removed, by the time it was updated', () => {
  const page = memoriesPage('otel');
  assert.deepEqual(page.columns.map((c) => c.name), ['updated_at', 'agent', 'scope', 'name', 'description', 'kind', 'still_valid', 'source_session_id', 'source_root_id', 'source_title', 'source_kind', 'source_score', 'format', 'captured_at']);
  assert.deepEqual([page.time, page.defaultSort, page.keys, page.fixed], ['m.updated_at', 'updated_at', ['agent', 'scope', 'name'], ["m.content_hash <> 'removed'"]]);
  const { rows } = tableSql(page, REQ, 'list');
  assert.match(rows.sql, /FROM \(SELECT agent, scope, name, max\(captured_at\) AS captured_at FROM otel\.agent_memories GROUP BY agent, scope, name\) l\nJOIN otel\.agent_memories m ON m\.agent = l\.agent AND m\.scope = l\.scope AND m\.name = l\.name AND m\.captured_at = l\.captured_at/);
  assert.match(rows.sql, /LEFT JOIN \(SELECT resource, max\(ts\) AS last_read FROM otel\.agent_events WHERE kind = 'tool_call' AND name = 'Read' AND resource IN \(SELECT location FROM otel\.agent_memories\) GROUP BY resource\) r ON r\.resource = m\.location/);
  assert.match(rows.sql, /CASE WHEN m\.format NOT IN \('claude-auto-memory'\) THEN 'unrecorded' WHEN v\.state IS NOT NULL THEN v\.state WHEN r\.last_read IS NULL OR r\.last_read <= m\.updated_at THEN 'unused' ELSE 'unjudged' END AS `still_valid`/);
  assert.match(rows.sql, /LEFT JOIN \(SELECT subject, max_by\(state, version\) AS state FROM otel\.agent_judgments WHERE judge = 'memory-validity' GROUP BY subject\) v ON v\.subject = concat\(md5\(concat_ws\('\\n', m\.agent, m\.scope, m\.name\)\), ':', left\(m\.content_hash, 16\)\)/);
  assert.match(rows.sql, /LEFT JOIN otel\.agent_sessions src ON src\.session_id = m\.source_session_id/);
  const searched = tableSql(page, { ...REQ, q: 'cache' }, 'list').rows.sql;
  assert.match(searched, /\(m\.name MATCH_PHRASE 'cache' OR m\.description MATCH_PHRASE 'cache' OR m\.content MATCH_PHRASE 'cache'\)/);
});

test('one memory: its versions newest first with the session it came from, and the calls that read or wrote it', () => {
  const { versions, uses, history } = memorySql('otel', { agent: 'claude-code', scope: '-home-u', name: "it's-cached" });
  assert.equal(history.title, 'States of the memory');
  assert.match(history.sql, /WHERE j\.judge = 'memory-validity' AND j\.subject IN \(SELECT concat\(md5\(concat_ws\('\\n', m\.agent, m\.scope, m\.name\)\), ':', left\(m\.content_hash, 16\)\) FROM otel\.agent_memories m\n {2}WHERE m\.agent = 'claude-code' AND m\.scope = '-home-u' AND m\.name = 'it\\'s-cached' AND m\.captured_at = \(SELECT max\(captured_at\) FROM otel\.agent_memories m WHERE m\.agent = 'claude-code' AND m\.scope = '-home-u' AND m\.name = 'it\\'s-cached'\)\)\nORDER BY j\.version DESC\nLIMIT 100$/);
  assert.match(versions.sql, /FROM otel\.agent_memories m\nLEFT JOIN otel\.agent_sessions src ON src\.session_id = m\.source_session_id\nWHERE m\.agent = 'claude-code' AND m\.scope = '-home-u' AND m\.name = 'it\\'s-cached'\nORDER BY m\.captured_at DESC\nLIMIT 50$/);
  assert.match(versions.sql, /CAST\(m\.sections AS STRING\) AS sections, CAST\(m\.fields AS STRING\) AS fields/);
  assert.match(uses.sql, /WHERE e\.kind = 'tool_call' AND e\.name IN \('Read', 'Write', 'Edit', 'MultiEdit'\)\n {2}AND e\.resource IN \(SELECT DISTINCT location FROM otel\.agent_memories m WHERE m\.agent = 'claude-code' AND m\.scope = '-home-u' AND m\.name = 'it\\'s-cached'\)\nORDER BY e\.ts DESC, e\.session_id, e\.seq\nLIMIT 100$/);
  assert.deepEqual([versions.title, uses.title], ['Versions of the memory', 'Calls that read or wrote it']);
});

test('the state of a memory: removed, use not recorded, not used since written, or read since and not judged yet', () => {
  const latest = { content_hash: 'h', format: 'claude-auto-memory', updated_at: '2026-11-10 00:00:00.000000' };
  const read = (ts: string, name = 'Read') => ({ name, ts });
  assert.equal(memoryState({ ...latest, content_hash: 'removed' }, []), 'removed');
  assert.equal(memoryState({ ...latest, format: 'gemini-md' }, [read('2026-11-12 00:00:00')]), 'unrecorded');
  assert.equal(memoryState(latest, [read('2026-11-09 00:00:00'), read('2026-11-12 00:00:00', 'Edit')]), 'unused');
  assert.equal(memoryState(latest, [read('2026-11-12 00:00:00')]), 'unjudged');
  assert.equal(memoryState(latest, [read('2026-11-12 00:00:00')], [{ state: 'outdated' }, { state: 'holds' }]), 'outdated', 'the latest state of the fold, newest first');
  assert.equal(memoryState({ ...latest, content_hash: 'removed' }, [], [{ state: 'holds' }]), 'removed');
});

test('the memories a session tree wrote: recorded as their source, or a file of theirs written by a call', () => {
  const s = wroteSql('otel', ['m', 'agent-a1']);
  assert.equal(s.title, 'Memories written');
  assert.match(s.sql, /WHERE m\.content_hash <> 'removed' AND \(\(m\.source_kind = 'recorded' AND m\.source_session_id IN \('m', 'agent-a1'\)\)\n {2}OR m\.location IN \(SELECT resource FROM otel\.agent_events WHERE session_id IN \('m', 'agent-a1'\) AND kind = 'tool_call' AND name IN \('Write', 'Edit', 'MultiEdit'\)\)\)/);
  assert.match(s.sql, /^SELECT DISTINCT m\.agent, m\.scope, m\.name\n/);
});
