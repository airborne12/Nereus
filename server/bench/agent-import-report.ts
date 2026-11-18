// Acceptance report for the transcript import (spec section 12, items 1 to 4 and 10), run after
// importing local transcripts into DORIS_DB:
//
//   node bench/agent-import-report.ts
//
// Prints sessions and sub-agents, calls with inexact contexts in files that have a request log,
// sub-agents not linked to a spawning call, and the stored size against the size of storing every
// request's full context.

import { Doris, configFromEnv } from '../src/db/doris.ts';

const db = process.env.DORIS_DB ?? 'otel';
const doris = new Doris(configFromEnv());
const one = async (sql: string) => (await doris.query(sql))[0] ?? {};

const sessions = await one(`SELECT sum(if(kind = 'main', 1, 0)) AS main, sum(if(kind = 'subagent', 1, 0)) AS sub,
  sum(if(kind = 'subagent' AND parent_seq IS NULL, 1, 0)) AS unlinked FROM ${db}.agent_sessions`);
const inexact = await one(`SELECT count(*) AS calls, count(DISTINCT e.session_id) AS sessions FROM ${db}.agent_events e
  WHERE e.kind = 'llm_call' AND NOT e.ctx_exact AND e.request_id IS NOT NULL
    AND e.session_id IN (SELECT DISTINCT session_id FROM ${db}.agent_events WHERE kind = 'llm_call' AND ctx_exact)`);
const full = await one(`SELECT sum(m.bytes) AS bytes FROM ${db}.agent_contexts c
  JOIN ${db}.agent_messages m ON m.session_id = c.session_id AND m.msg_seq BETWEEN c.from_msg AND c.to_msg
  WHERE c.rel = 'in'`);
const TABLES = ['agent_sessions', 'agent_events', 'agent_messages', 'agent_contexts', 'agent_prompts'];
// SHOW DATA takes one table when no database is selected.
const stored = [];
for (const t of TABLES) stored.push(...(await doris.query(`SHOW DATA FROM ${db}.${t}`)));

console.log(`sessions: ${String(sessions.main)} main, ${String(sessions.sub)} sub-agents, ${String(sessions.unlinked)} sub-agents not linked to a call`);
console.log(`calls with an inexact context in sessions that have a request log: ${String(inexact.calls)} in ${String(inexact.sessions)} sessions`);
console.log(`text of every request's full context: ${(Number(full.bytes) / 1e9).toFixed(2)} GB`);
console.log('stored size by table:');
for (const r of stored) console.log(`  ${Object.values(r).map(String).join('  ')}`);
await doris.close();
