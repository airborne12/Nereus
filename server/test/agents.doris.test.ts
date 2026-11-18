// The import command against a live Doris: the fixture imported, imported again unchanged, and forced
// again with the same rows. Skipped unless DORIS_TEST=1; needs DORIS_BE_HTTP_URL for Stream Load.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importFile } from '../src/cli/import-transcripts.ts';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../src/db/stream-load.ts';
import type { Load } from '../src/semantics/ingest/writer.ts';
import { AGENT_FILE_ID, MAIN_ID, writeFixture } from './fixtures/claude-transcript.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_agents_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const TABLES = ['agent_sessions', 'agent_events', 'agent_messages', 'agent_contexts', 'agent_prompts'];
let doris: Doris;
let dir = '';
let main = '';
let load: Load;

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  load = (table, label, rows) => streamLoad(cfg, db, table, label, rows);
  dir = mkdtempSync(join(tmpdir(), 'nereus-agents-'));
  main = writeFixture(dir);
});
after(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
});

/** Row count and an order-independent checksum of every column, per table. */
async function fingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    // The pool makes DESC list VARIANT sub-paths too (args.command); only real columns are kept.
    const cols = (await doris.query(`DESC ${db}.${t}`)).map((r) => String(r.Field)).filter((f) => !f.includes('.'))
      .map((f) => `cast(\`${f}\` AS STRING)`);
    const [r] = await doris.query(`SELECT count(*) AS n, sum(murmur_hash3_32(concat_ws('|', ${cols.join(', ')}))) AS h FROM ${db}.${t}`);
    out[t] = `${String(r!.n)}:${String(r!.h)}`;
  }
  return out;
}

test('import, re-import unchanged, forced re-import: same rows', { skip: !enabled }, async () => {
  const first = await importFile(main, { doris, db, load });
  assert.deepEqual([first.status, first.branches, first.events, first.messages], ['imported', 2, 17, 19]);
  const before = await fingerprint();
  assert.equal((await importFile(main, { doris, db, load })).status, 'unchanged');
  assert.equal((await importFile(main, { doris, db, load, force: true })).status, 'imported');
  assert.deepEqual(await fingerprint(), before);
});

test('the session tree and its totals', { skip: !enabled }, async () => {
  const rows = await doris.query(`SELECT session_id, root_id, parent_id, parent_seq, kind, turns, steps, tool_calls, tool_errors, subagents,
    compactions, last_seq, last_msg_seq, first_input, last_output, title FROM ${db}.agent_sessions ORDER BY kind`);
  const pick = (r: Record<string, unknown>) => [r.session_id, r.parent_id, r.parent_seq === null ? null : Number(r.parent_seq), r.kind,
    Number(r.turns), Number(r.steps), Number(r.tool_calls), Number(r.tool_errors), Number(r.subagents), Number(r.compactions), Number(r.last_seq), Number(r.last_msg_seq)];
  assert.deepEqual(rows.map(pick), [
    [MAIN_ID, null, null, 'main', 2, 7, 5, 1, 1, 1, 13, 15],
    [AGENT_FILE_ID, MAIN_ID, 8, 'subagent', 1, 2, 1, 0, 0, 0, 4, 4],
  ]);
  assert.equal(rows[0]!.first_input, 'Fix the failing test in tests/clock_test.py 😀', '4-byte characters survive Stream Load');
  assert.equal(rows[0]!.last_output, 'Noted: the public API stays unchanged.');
  assert.equal(rows[0]!.title, 'Fix the clock test');
});

test('contexts and repeats as stored', { skip: !enabled }, async () => {
  const ranges = await doris.query(`SELECT rel, from_msg, to_msg FROM ${db}.agent_contexts WHERE session_id = '${MAIN_ID}' AND seq = 13 ORDER BY rel, pos`);
  assert.deepEqual(ranges.map((r) => [r.rel, Number(r.from_msg), Number(r.to_msg)]), [['in', 14, 14], ['in', 13, 13], ['out', 1, 11]]);
  const [rep] = await doris.query(`SELECT repeat_of, repeat_visible, resource FROM ${db}.agent_events WHERE session_id = '${MAIN_ID}' AND seq = 6`);
  assert.deepEqual([Number(rep!.repeat_of), Number(rep!.repeat_visible), rep!.resource], [3, 1, 'tests/clock_test.py']);
  const [p] = await doris.query(`SELECT system_text, tool_names FROM ${db}.agent_prompts`);
  assert.equal(p!.system_text, 'You are a coding agent.');
  assert.deepEqual(JSON.parse(String(p!.tool_names)), ['Read', 'Bash']);
});

test('a re-import removes rows the current transcript no longer produces', { skip: !enabled }, async () => {
  await doris.query(`INSERT INTO ${db}.agent_events (session_id, seq, ts, turn, step, kind) VALUES ('${MAIN_ID}', 99, '2026-11-17 10:00:00.000000', 1, 1, 'note')`);
  await doris.query(`INSERT INTO ${db}.agent_messages (session_id, msg_seq, ts, content_hash, msg_role, kind, api_msg) VALUES ('${MAIN_ID}', 99, '2026-11-17 10:00:00.000000', 'h', 'user', 'text', 1)`);
  await importFile(main, { doris, db, load, force: true });
  const [e] = await doris.query(`SELECT count(*) AS n FROM ${db}.agent_events WHERE session_id = '${MAIN_ID}' AND seq = 99`);
  const [m] = await doris.query(`SELECT count(*) AS n FROM ${db}.agent_messages WHERE session_id = '${MAIN_ID}' AND msg_seq = 99`);
  assert.deepEqual([Number(e!.n), Number(m!.n)], [0, 0]);
  const [s] = await doris.query(`SELECT steps, tool_calls FROM ${db}.agent_sessions WHERE session_id = '${MAIN_ID}'`);
  assert.deepEqual([Number(s!.steps), Number(s!.tool_calls)], [7, 5]);
});

test('after the tables are emptied, a forced import loads the rows again', { skip: !enabled }, async () => {
  for (const t of TABLES) await doris.query(`TRUNCATE TABLE ${db}.${t}`);
  await importFile(main, { doris, db, load, force: true });
  const [e] = await doris.query(`SELECT count(*) AS n FROM ${db}.agent_events`);
  assert.equal(Number(e!.n), 17);
});
