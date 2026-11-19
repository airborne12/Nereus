// The agent tables are created as the spec defines them (section 5). Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_agent_schema_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let doris: Doris;

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
});
after(async () => {
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
});

const columns = async (table: string) => (await doris.query(`DESC ${db}.${table}`)).map((r) => String(r.Field));

test('eight unique-key tables with the spec columns', { skip: !enabled }, async () => {
  assert.deepEqual((await doris.query(`SHOW TABLES FROM ${db}`)).map((r) => String(Object.values(r)[0])).sort(),
    ['agent_contexts', 'agent_events', 'agent_judges', 'agent_judgments', 'agent_messages', 'agent_prompts', 'agent_risks', 'agent_sessions']);
  assert.deepEqual((await columns('agent_risks')), ['session_id', 'rule', 'first_seq', 'rule_version', 'rule_name', 'root_id', 'ts', 'turn', 'events', 'steps', 'what', 'why', 'found_at']);
  assert.deepEqual((await columns('agent_judges')), ['judge', 'version', 'name', 'form', 'pick', 'reads', 'criterion', 'model', 'created_at', 'created_by']);
  assert.deepEqual((await columns('agent_judgments')), [
    'judge', 'subject', 'judge_version', 'version', 'session_id', 'seq', 'verdict', 'state', 'evidence', 'prev_version',
    'reason', 'input_seqs', 'input_hash', 'model', 'input_tokens', 'output_tokens', 'judged_at',
  ]);
  const judgments = String(Object.values((await doris.query(`SHOW CREATE TABLE ${db}.agent_judgments`))[0]!)[1]);
  assert.match(judgments, /UNIQUE KEY\(`judge`, `subject`, `judge_version`, `version`\)/);
  assert.match(judgments, /DISTRIBUTED BY HASH\(`subject`\)/);
  assert.deepEqual((await columns('agent_contexts')), ['session_id', 'seq', 'rel', 'pos', 'ts', 'from_msg', 'to_msg']);
  assert.ok((await columns('agent_messages')).includes('msg_role'));
  assert.ok((await columns('agent_prompts')).includes('system_text'));
  for (const c of ['turns', 'steps', 'tool_errors', 'peak_ctx_tokens', 'active_us', 'first_input', 'last_output', 'safety_risks']) {
    assert.ok((await columns('agent_sessions')).includes(c), c);
  }
  const ddl = String(Object.values((await doris.query(`SHOW CREATE TABLE ${db}.agent_events`))[0]!)[1]);
  assert.match(ddl, /UNIQUE KEY\(`session_id`, `seq`, `ts`\)/);
  assert.match(ddl, /"enable_unique_key_merge_on_write" = "true"/);
});

// A JSON text goes into VARIANT through JSON; inserted as text it would stay a string scalar.
test('a row with emoji text and a VARIANT payload round-trips through INSERT', { skip: !enabled }, async () => {
  await doris.query(`INSERT INTO ${db}.agent_messages (session_id, msg_seq, ts, content_hash, msg_role, kind, api_msg, text, payload)
    VALUES ('s1', 1, '2026-11-17 10:00:00.000000', 'h', 'user', 'text', 1, 'fix 😀 中文', CAST(CAST('{"a":1}' AS JSON) AS VARIANT))`);
  const [row] = await doris.query(`SELECT text, cast(payload['a'] AS INT) AS a FROM ${db}.agent_messages`);
  assert.equal(row!.text, 'fix 😀 中文');
  assert.equal(Number(row!.a), 1);
});
