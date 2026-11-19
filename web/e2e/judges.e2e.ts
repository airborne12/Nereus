// Browser test of the Judges pages against a live Doris and PostgreSQL, with a stub in place of the
// model. Starts the API service in-process (serving web/dist), makes a judge on the form, runs it
// with the job, then walks its page: the plan, the views, what the model read, a new version and a
// rerun; in headless Chromium.
//
//   npm run build && DORIS_BE_HTTP_URL=http://127.0.0.1:8040 SHOTS=/tmp/shots node --test e2e/judges.e2e.ts

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { importFile } from '../../server/src/cli/import-transcripts.ts';
import { AuthStore } from '../../server/src/control/auth/store.ts';
import { ContentStore } from '../../server/src/control/content/store.ts';
import { JudgeStore } from '../../server/src/control/judges/store.ts';
import { Doris, configFromEnv } from '../../server/src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../../server/src/db/stream-load.ts';
import { type JudgeJobDeps, runJudges } from '../../server/src/jobs/judges.ts';
import { IngestKeys } from '../../server/src/rum/http.ts';
import type { JudgeModel } from '../../server/src/semantics/judges/model.ts';
import { createApp } from '../../server/src/server.ts';
import { writeFixture } from '../../server/test/fixtures/claude-transcript.ts';
import { RISK_ID, writeRisks } from '../../server/test/fixtures/risk-transcript.ts';
import { RISKY, sequenceLines } from '../../server/test/fixtures/sequence-transcript.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';
import { applySchemaFile } from '../../server/test/schema-helper.ts';

const shots = process.env.SHOTS;
const db = `nereus_judge_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const NOW = Date.parse('2026-11-17T18:00:00Z');
const errors: string[] = [];
let browser: Browser;
let page: Page;
let base = '';
let dir = '';
let deps: JudgeJobDeps;
let stop: () => Promise<void> = async () => {};

/** A model that says a step violates when a call before it failed, or always when the criterion says "every". */
const stub: JudgeModel = {
  judge: async (_m, criterion, excerpt) => (excerpt.includes('(failed)') || criterion.includes('every')
    ? { verdict: 'violates', reason: 'A call before it failed.', inputTokens: 120, outputTokens: 9 } : { verdict: 'ok', reason: 'Nothing failed before it.', inputTokens: 100, outputTokens: 8 }),
};

before(async () => {
  const doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-judge-e2e-'));
  const generated = join(dir, 'fx-judgee2e-0001.jsonl');
  writeFileSync(generated, `${sequenceLines('fx-judgee2e-0001', 23, 30, '2026-11-17', RISKY).join('\n')}\n`);
  for (const file of [writeRisks(dir), writeFixture(dir), generated]) await importFile(file, { doris, db, load });
  const meta = await freshMetaDb();
  const store = new JudgeStore(meta.pool);
  deps = { doris, db, load, store, model: stub, runner: 'e2e-runner' };
  const auth = new AuthStore(meta.pool);
  await auth.setup('admin@example.com', 'Ada Admin', 'adminpass1');
  const webDir = new URL('../dist', import.meta.url).pathname;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool), webDir, judges: { store, model: stub } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('adminpass1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Sessions', level: 1 }).waitFor();
  if (shots) mkdirSync(shots, { recursive: true });
  stop = async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    await meta.drop();
    try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
  };
});
after(async () => {
  await stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const shot = (name: string) => (shots ? page.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve());
const count = () => page.getByRole('status').filter({ hasText: / in \d+ session/ }).innerText();
const stage = (no: number) => page.locator('.jg-stage').nth(no - 1);
const rows = () => page.locator('.jg-verdicts tbody tr.jg-row');
let judgeUrl = '';

test('Judges is a page of the navigation; with no judge it says how to make one', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Judges', exact: true }).click();
  await page.waitForURL(`${base}/agents/judges`);
  await page.getByRole('heading', { name: 'Judges', level: 1 }).waitFor();
  await page.locator('.ag-none', { hasText: 'No judge yet' }).waitFor();
  await page.getByRole('button', { name: 'New judge' }).click();
  await page.waitForURL(`${base}/agents/judges/new`);
  await page.getByRole('heading', { name: 'New judge', level: 1 }).waitFor();
});

test('the form: the pick changes the count, a try shows five verdicts, and Run saves the judge', async () => {
  await page.locator('.jg-count', { hasText: /^\d+ steps? in \d+ sessions?$/ }).waitFor();
  const edits = await count();
  assert.equal(await page.getByLabel('Start from').inputValue(), 'test');
  await page.getByLabel('Tool', { exact: true }).selectOption('Bash');
  await page.getByLabel('Target contains').fill('rm | curl');
  await page.waitForFunction((before) => {
    const t = document.querySelector('.jg-count')?.textContent ?? '';
    return t !== before && / in \d+ session/.test(t);
  }, edits);
  // Reading the whole turn; a criterion of one's own.
  await page.getByLabel('The whole turn up to the step').check();
  await page.getByLabel('Criterion').fill('Is a command run that the user did not ask for?');
  assert.equal(await page.getByLabel('Start from').inputValue(), 'own');
  await page.getByLabel('Name', { exact: true }).fill('Commands nobody asked for');
  await page.getByRole('button', { name: 'Try on 5 steps' }).click();
  await page.locator('.jg-try').nth(4).waitFor();
  assert.equal(await page.locator('.jg-try .jg-verdict').count(), 5);
  assert.equal(await page.locator('.jg-try li.judged').count(), 5);
  await shot('judge-01-form');
  await page.getByRole('button', { name: /^Run on \d+ steps?$/ }).click();
  await page.waitForURL((u) => /^\/agents\/judges\/commands-nobody-asked-for-[0-9a-f]{6}$/.test(u.pathname));
  judgeUrl = page.url();
  await page.getByRole('heading', { name: 'Commands nobody asked for', level: 1 }).waitFor();
  await stage(4).locator('.jg-run', { hasText: 'Last run: queued' }).waitFor();
  assert.match(await stage(1).innerText(), /Bash calls on "rm \| curl": 0 steps judged\./);
});

test('after the run, the judge shows its verdicts; a row shows what the model read and opens the step', async () => {
  const report = await runJudges(deps);
  assert.equal(report.runs[0]?.status, 'done');
  await page.goto(judgeUrl);
  await stage(4).locator('.jg-run', { hasText: 'Last run: done' }).waitFor();
  assert.match(await stage(1).innerText(), new RegExp(`${report.runs[0]!.judged} steps judged`));
  // The first violation in each session: the stub says a step violates when a call before it failed.
  await rows().first().waitFor();
  await page.getByRole('button', { name: 'All verdicts' }).click();
  await page.waitForURL((u) => u.searchParams.get('view') === 'all');
  await page.locator('.jg-verdicts tbody tr.jg-row').nth(report.runs[0]!.judged - 1).waitFor();
  assert.equal(await rows().count(), report.runs[0]!.judged);
  await rows().first().click();
  await page.waitForURL((u) => (u.searchParams.get('row') ?? '').includes(':'));
  const detail = page.getByRole('region', { name: 'What the model read' });
  await detail.locator('.jg-record li.judged').waitFor();
  assert.match(await detail.locator('h3').innerText(), /^What the model read for step \d+ · Bash /);
  assert.equal(await detail.locator('.jg-why').count(), 1);
  await shot('judge-02-verdicts');
  await detail.getByRole('button', { name: 'Open the step in its session' }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/agents/sessions/') && (u.searchParams.get('sel') ?? '').startsWith('s:'));
  await page.goBack();
  await page.waitForURL((u) => u.pathname.startsWith('/agents/judges/'));
});

test('a new version makes the verdicts out of date; a rerun of all brings them up to date and shows what changed', async () => {
  await page.goto(judgeUrl);
  await page.getByRole('button', { name: 'Change criterion or model' }).click();
  await stage(3).locator('textarea').fill('Is every command run that the user did not ask for?');
  await page.getByRole('button', { name: 'Save as v2' }).click();
  await page.getByRole('status').filter({ hasText: 'Saved version 2. Nothing was judged again.' }).waitFor();
  const staled = stage(4).locator('.jg-staled');
  await staled.waitFor();
  assert.match(await staled.innerText(), /\d+ verdicts? out of date\. An older version made them; the judge is now v2\./);
  assert.deepEqual(await stage(3).locator('.jg-versions tbody tr').evaluateAll((trs) => trs.map((tr) => tr.children[2]!.textContent)), ['criterion', '']);
  await shot('judge-03-stale');
  await staled.getByRole('button', { name: /^Rerun all \d+$/ }).click();
  await page.getByRole('status').filter({ hasText: 'Rerun queued. The run-judges command takes it.' }).waitFor();
  await runJudges(deps);
  await page.goto(`${judgeUrl}?view=changed`);
  await rows().first().waitFor();
  assert.equal(await stage(4).locator('.jg-staled').count(), 0);
  const first = rows().first().locator('td');
  assert.deepEqual([await first.nth(3).innerText(), await first.nth(4).innerText()], ['Does not violate v1', 'Violates v2']);
});

test('the list shows the judge with its version and counts', async () => {
  await page.getByRole('button', { name: '← Judges' }).click();
  await page.waitForURL(`${base}/agents/judges`);
  const row = page.locator('.ag-table tbody tr', { hasText: 'Commands nobody asked for' });
  await row.waitFor();
  const cells = (await row.locator('td').allInnerTexts()).map((t) => t.trim());
  assert.deepEqual(cells.slice(1, 6), ['Commands nobody asked for', 'Bash calls on "rm | curl"', 'claude-haiku-5-5', '2', 'new sessions too']);
  assert.equal(cells[9], '0', 'nothing is out of date after the rerun');
  assert.ok(Number(cells[6]) > 0 && Number(cells[7]) === Number(cells[6]), 'every verdict of v2 violates');
});

test('the dark theme and a 400 px window', async () => {
  const context = await browser.newContext({ viewport: { width: 400, height: 800 }, timezoneId: 'UTC', colorScheme: 'dark', storageState: await page.context().storageState() });
  const small = await context.newPage();
  await small.clock.setFixedTime(NOW);
  small.on('pageerror', (e) => errors.push(e.message));
  for (const url of [`${base}/agents/judges`, judgeUrl, `${base}/agents/judges/new`]) {
    await small.goto(url);
    await small.locator('.ag-page h1').waitFor();
    assert.ok(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), url);
  }
  if (shots) await small.screenshot({ path: `${shots}/judge-04-dark-400.png` });
  await context.close();
});

test('no page raised an error', () => {
  assert.deepEqual(errors, []);
  assert.ok(RISK_ID);
});
