// Times of the agent API statements on imported data (spec 12, item 5), run against DORIS_DB:
//
//   node bench/agent-api-report.ts [runs]
//
// Picks the main session with the most model calls and its longest turn, then runs each statement
// of the table pages, the session page, a step, Compare and the export size `runs` times (5 by
// default) and prints the median and the slowest time in milliseconds.

import mysql from 'mysql2/promise';
import type { Row } from '../src/db/doris.ts';
import { compareSql } from '../src/semantics/trajectory/compare.ts';
import { conversationSql } from '../src/semantics/trajectory/export.ts';
import { messagesPage, sessionsPage, stepsPage } from '../src/semantics/trajectory/pages.ts';
import { type Statement, tableSql, type TableRequest } from '../src/semantics/trajectory/query.ts';
import { stepSql, treeSql, turnStepsSql, turnSql, turnsSql } from '../src/semantics/trajectory/session.ts';

const db = process.env.DORIS_DB ?? 'otel';
const runs = Number(process.argv[2] ?? 5);
const conn = await mysql.createConnection({
  host: process.env.DORIS_HOST ?? '127.0.0.1', port: Number(process.env.DORIS_PORT ?? 9030), user: process.env.DORIS_USER ?? 'root',
  password: process.env.DORIS_PASSWORD ?? '', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
});
// As the server's pool sets them, plus no result cache so every run executes.
await conn.query('SET inverted_index_skip_threshold = 0, query_timeout = 300, describe_extend_variant_column = true');
await conn.query('SET enable_sql_cache = false');
const query = async (sql: string) => (await conn.query(sql))[0] as Row[];
const one = async (sql: string) => (await query(sql))[0] ?? {};

const big = await one(`SELECT session_id, steps, started_at, last_event_at FROM ${db}.agent_sessions WHERE kind = 'main' ORDER BY steps DESC LIMIT 1`);
const id = String(big.session_id);
const turn = await one(`SELECT turn, count(*) AS steps FROM ${db}.agent_events WHERE session_id = '${id}' AND kind = 'llm_call' GROUP BY turn ORDER BY steps DESC LIMIT 1`);
const call = await one(`SELECT max(seq) AS seq FROM ${db}.agent_events WHERE session_id = '${id}' AND kind = 'llm_call'`);
const other = await one(`SELECT session_id FROM ${db}.agent_sessions WHERE kind = 'main' AND session_id <> '${id}' ORDER BY steps DESC LIMIT 1`);
const tree = await query(treeSql(db, id).sql);
const range: TableRequest = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', q: '', conditions: [], limit: 100, offset: 0 };
const step = stepSql(db, id, Number(call.seq), 0);

const statements: Statement[] = [
  { ...tableSql(sessionsPage(db), range, 'list').rows, title: 'Sessions rows' },
  { ...tableSql(sessionsPage(db), { ...range, q: 'test' }, 'list').rows, title: 'Sessions rows, search' },
  { ...tableSql(stepsPage(db), range, 'list').rows, title: 'Steps rows' },
  { ...tableSql(stepsPage(db), { ...range, q: 'test' }, 'list').rows, title: 'Steps rows, search' },
  { ...tableSql(stepsPage(db), range, 'list').total, title: 'Steps total' },
  { ...tableSql(messagesPage(db), { ...range, q: 'test' }, 'list').rows, title: 'Messages rows, search' },
  treeSql(db, id), turnsSql(db, tree.map((r) => String(r.session_id))), turnStepsSql(db, id, Number(turn.turn), 0), turnSql(db, id, Number(turn.turn)),
  step.event, step.input, step.output, step.prompt,
  ...compareSql(db, id, String(other.session_id ?? id), 1),
  conversationSql(db, { ...range, conditions: [{ column: 'session_id', op: 'eq', value: id }] }, false).size,
];

console.log(`session ${id}: ${String(big.steps)} model calls, longest turn ${String(turn.turn)} with ${String(turn.steps)}; ${runs} runs each`);
for (const s of statements) {
  const times: number[] = [];
  let rows = 0;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    rows = (await query(s.sql)).length;
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`${s.title.padEnd(26)} median ${times[Math.floor(times.length / 2)]!.toFixed(0).padStart(5)} ms  max ${times.at(-1)!.toFixed(0).padStart(5)} ms  rows ${rows}`);
}
await conn.end();
