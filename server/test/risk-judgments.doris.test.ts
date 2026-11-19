// The risk judges on a live Doris and PostgreSQL, with a stub in place of the model: what the model
// reads for a risk of the session written by hand, word for word; every risk is judged once by its
// rule's judge (spec 12, item 7); the Risks table and the risks of a session read the judgments;
// the record of a sub-agent's risk and of a risk that spans many steps. Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { importFile } from '../src/cli/import-transcripts.ts';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../src/db/stream-load.ts';
import { Leases } from '../src/jobs/leases.ts';
import { judgeRisks, type RiskJudgeDeps } from '../src/jobs/risk-judgments.ts';
import { runRules } from '../src/jobs/rules.ts';
import type { JudgeModel } from '../src/semantics/judges/model.ts';
import { RISK_JUDGES, riskReadsSql, unjudgedRisksSql } from '../src/semantics/judges/risk-judges.ts';
import { RISK_SYSTEM, riskExcerptsOf } from '../src/semantics/judges/risk-record.ts';
import { risksPage, treeRisksSql } from '../src/semantics/sequences/risks.ts';
import { tableSql } from '../src/semantics/trajectory/query.ts';
import { HELPER_ID, RISK_ID, writeConfirmations, writeRisks } from './fixtures/risk-transcript.ts';
import { RISKY, sequenceLines } from './fixtures/sequence-transcript.ts';
import { freshMetaDb } from './meta-helper.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_riskjudge_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let doris: Doris;
let pool: pg.Pool;
let deps: Omit<RiskJudgeDeps, 'model'>;
let load: RiskJudgeDeps['load'];
let dir = '';
let close: () => Promise<void> = async () => {};

/** A stub model: a command outside the allowed set is a breach, a missing confirmation needs a person, the rest are not breaches. */
const asked: { system: string | undefined; text: string }[] = [];
const stub: JudgeModel = {
  judge: async (_m, _c, x, system) => {
    asked.push({ system, text: x });
    const verdict = x.startsWith('<rule>Command outside') ? 'violates' : x.startsWith('<rule>Irreversible') ? 'unsure' : 'ok';
    return { verdict, reason: `Stub said ${verdict}.`, inputTokens: 700, outputTokens: 12 };
  },
};

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  // The clean-up is set first, so that a set-up that fails does not leave the connection open.
  let drop = async () => {};
  close = async () => {
    await drop();
    try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
  };
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-riskjudge-'));
  await importFile(writeRisks(dir), { doris, db, load });
  const meta = await freshMetaDb();
  drop = () => meta.drop();
  pool = meta.pool;
  assert.equal((await runRules({ doris, db, load, leases: new Leases(pool) })).risks, 6);
  deps = { doris, db, load, leases: new Leases(pool), now: () => new Date('2026-11-19T10:00:00Z') };
});
after(async () => {
  await close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the model reads a risk as the rule and why, then its events in order, the matched ones marked', { skip: !enabled }, async () => {
  const confirm = RISK_JUDGES.find((j) => j.rule === 'confirm')!;
  // The list is newest first; the earlier of the two is the one after "Tidy it up".
  const risks = (await doris.query(unjudgedRisksSql(db, confirm).sql)).map((r) => ({ session_id: String(r.session_id), rule: String(r.rule), first_seq: Number(r.first_seq) }))
    .sort((a, b) => a.first_seq - b.first_seq);
  assert.equal(risks.length, 2);
  const [tidy] = riskExcerptsOf(await doris.query(riskReadsSql(db, risks).sql), risks);
  assert.equal(tidy!.subject, `${RISK_ID}:confirm:${risks[0]!.first_seq}`);
  assert.equal(tidy!.text, [
    `<rule>Irreversible command without the user's confirmation: The last thing the user said before it was "Tidy it up", and the assistant did not ask before running it.</rule>`,
    '<step>\nCalled Bash: pytest tests/clock_test.py\nResult: ok\n</step>',
    '<step>\nAssistant: The test passes now.\n</step>',
    '<user judged="true">\nTidy it up\n</user>',
    '<step judged="true">\nCalled Bash: rm -rf build\nResult: ok\n</step>',
  ].join('\n'));
});

test('every risk is judged once by its rule\'s judge, with the risk system prompt; a second pass judges none', { skip: !enabled }, async () => {
  const first = await judgeRisks({ ...deps, model: stub });
  assert.deepEqual(first, { judged: 6, stopped: false, held: 0, failed: [], missed: null });
  assert.ok(asked.every((a) => a.system === RISK_SYSTEM));
  const rows = await doris.query(`SELECT judge, subject, judge_version, verdict, array_size(input_seqs) AS n FROM ${db}.agent_judgments ORDER BY subject`);
  const risks = await doris.query(`SELECT session_id, rule, first_seq FROM ${db}.agent_risks ORDER BY session_id, rule, first_seq`);
  assert.deepEqual(rows.map((r) => String(r.subject)).sort(), risks.map((r) => `${r.session_id}:${r.rule}:${r.first_seq}`).sort());
  assert.ok(rows.every((r) => String(r.judge) === `risk-${String(r.subject).split(':')[1]}` && Number(r.judge_version) === 1 && Number(r.n) > 0));
  assert.deepEqual((await doris.query(`SELECT judge, version, created_by FROM ${db}.agent_judges ORDER BY judge`)).map((r) => [r.judge, Number(r.version), r.created_by]),
    [...RISK_JUDGES].map((j) => [j.judge, 1, 'nereus']).sort());
  assert.deepEqual(await judgeRisks({ ...deps, model: stub }), { judged: 0, stopped: false, held: 0, failed: [], missed: null });
});

test('the Risks table and the risks of a session read the latest judgment', { skip: !enabled }, async () => {
  const { rows } = tableSql(risksPage(db), { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z', q: '', conditions: [], limit: 100, offset: 0 }, 'list');
  const byRule = (await doris.query(rows.sql)).map((r) => [String(r.rule), String(r.judgment)]).sort();
  assert.deepEqual(byRule, [['confirm', 'review'], ['confirm', 'review'], ['deny', 'breach'], ['deny', 'breach'], ['exfil', 'ok'], ['subvert', 'ok']]);
  const tree = await doris.query(treeRisksSql(db, RISK_ID).sql);
  const deny = tree.find((r) => r.rule === 'deny')!;
  assert.deepEqual([deny.judgment, deny.judgment_reason, deny.judgment_model, Number(deny.judge_version), String(deny.judged_at).slice(0, 19)],
    ['breach', 'Stub said violates.', 'claude-haiku-5-5', 1, '2026-11-19 10:00:00']);
  assert.ok(Number(deny.read_events) > 0);
});

/** The record of the risks of one session and rule, as the model reads them. */
async function records(session: string, rule: string) {
  const risks = (await doris.query(`SELECT session_id, rule, first_seq FROM ${db}.agent_risks WHERE session_id = '${session}' AND rule = '${rule}' ORDER BY first_seq`))
    .map((r) => ({ session_id: String(r.session_id), rule: String(r.rule), first_seq: Number(r.first_seq) }));
  return risks.length ? riskExcerptsOf(await doris.query(riskReadsSql(db, risks).sql), risks) : [];
}

test("a sub-agent's input is its parent agent's task, and a long risk says which steps it leaves out", { skip: !enabled }, async () => {
  const generated = join(dir, 'fx-riskjudge-0001.jsonl');
  writeFileSync(generated, `${sequenceLines('fx-riskjudge-0001', 11, 60, '2026-11-17', RISKY).join('\n')}\n`);
  for (const file of [writeConfirmations(dir), generated]) await importFile(file, { doris, db, load });
  await runRules({ doris, db, load, leases: new Leases(pool) });
  const [helper] = await records(HELPER_ID, 'confirm');
  assert.match(helper!.text, /\n<task from="parent agent">\nDelete everything in tmp\n<\/task>\n/);
  assert.ok(!helper!.text.includes('<user'), 'a sub-agent has no user');
  // A risk whose events lie more than 30 steps apart reads the steps of its events, says how many it leaves out, and the request of each turn it has events in.
  const spans = await doris.query([
    'SELECT r.rule, r.first_seq, max(e.step) - min(e.step) AS span, count(DISTINCT e.turn) AS turns',
    `FROM ${db}.agent_risks r LATERAL VIEW explode(r.events) t AS ev JOIN ${db}.agent_events e ON e.session_id = r.session_id AND e.seq = t.ev`,
    "WHERE r.session_id = 'fx-riskjudge-0001' GROUP BY r.rule, r.first_seq HAVING max(e.step) - min(e.step) > 30 ORDER BY span DESC LIMIT 1",
  ].join('\n'));
  assert.equal(spans.length, 1, 'the generated session has a risk over more than 30 steps');
  const ref = { session_id: 'fx-riskjudge-0001', rule: String(spans[0]!.rule), first_seq: Number(spans[0]!.first_seq) };
  const [long] = riskExcerptsOf(await doris.query(riskReadsSql(db, [ref]).sql), [ref]);
  assert.match(long!.text, /<omitted steps="\d+"\/>/);
  const marked = long!.text.match(/<step judged="true">/g) ?? [];
  assert.ok(marked.length >= 2, long!.text.slice(0, 400));
  const inputs = long!.text.match(/\n<(user|harness)( judged="true")?>\n/g) ?? [];
  assert.ok(inputs.length >= Number(spans[0]!.turns), `${inputs.length} inputs for ${spans[0]!.turns} turns`);
});
