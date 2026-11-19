// The agent tables as query sources of search, charts and alerts (spec 5.10; no database).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchRowsSql } from '../src/semantics/search/build.ts';
import { sourcesFor } from '../src/server.ts';

const range = { from: '2026-11-17 00:00:00', to: '2026-11-18 00:00:00' };

test('sessions, events, messages and risks are registered beside logs, traces and metrics', () => {
  assert.deepEqual(Object.keys(sourcesFor('otel')), ['logs', 'traces', 'metrics', 'agent_sessions', 'agent_events', 'agent_messages', 'agent_risks']);
});

test('risks: a bare word searches what happened and the rule', () => {
  const { sql } = searchRowsSql(sourcesFor('otel').agent_risks!, { ...range, where: 'curl AND rule:exfil' });
  assert.match(sql, /FROM otel\.agent_risks WHERE ts >= /);
  assert.match(sql, /search\('\(\(what:curl OR rule_name:curl\) AND rule:exfil\)'\)/);
});

test('the search language on agent messages: role is msg_role, a bare word searches the text', () => {
  const { sql } = searchRowsSql(sourcesFor('otel').agent_messages!, { ...range, where: 'role:assistant AND utc' });
  assert.equal(sql, "SELECT * FROM otel.agent_messages WHERE ts >= '2026-11-17 00:00:00.000' AND ts < '2026-11-18 00:00:00.000' "
    + "AND search('(msg_role:assistant AND text:utc)') ORDER BY ts DESC LIMIT 200");
});

test('agent events: tool is the name, durations take units; sessions search title and texts', () => {
  const events = searchRowsSql(sourcesFor('otel').agent_events!, { ...range, where: 'duration_us:>2s AND tool:Read' }).sql;
  assert.match(events, /\(duration_us > 2000000 AND search\('name:Read'\)\)/);
  const sessions = searchRowsSql(sourcesFor('otel').agent_sessions!, { ...range, where: 'clock AND steps:>5' }).sql;
  assert.match(sessions, /search\('\(\(title:clock OR first_input:clock\) OR last_output:clock\)'\) AND steps > 5/);
  assert.match(sessions, /WHERE last_event_at >= /);
});
