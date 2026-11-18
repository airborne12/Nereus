// Browser test of the agent trajectory pages against a live Doris: the hand-written fixture imported
// twice (the second copy with its failing call fixed, for Compare) and a fresh PostgreSQL metadata
// database. Starts the API service in-process (serving web/dist) and walks Sessions, Steps,
// Messages, the session page, Compare, SQL and Export in headless Chromium, then looks at the pages
// in the dark theme and at 400 px width. The browser's clock stands just after the fixture.
//
//   npm run build && DORIS_BE_HTTP_URL=http://127.0.0.1:8040 SHOTS=/tmp/shots node --test e2e/agents.e2e.ts

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { importFile } from '../../server/src/cli/import-transcripts.ts';
import { AuthStore } from '../../server/src/control/auth/store.ts';
import { ContentStore } from '../../server/src/control/content/store.ts';
import { Doris, configFromEnv } from '../../server/src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../../server/src/db/stream-load.ts';
import { IngestKeys } from '../../server/src/rum/http.ts';
import { createApp } from '../../server/src/server.ts';
import { AGENT_FILE_ID, MAIN_ID, writeFixture } from '../../server/test/fixtures/claude-transcript.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';
import { applySchemaFile } from '../../server/test/schema-helper.ts';

const shots = process.env.SHOTS;
const db = `nereus_agent_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const OTHER = 'fx-main-0002';
// The fixture runs on 2026-11-17 from 10:00 to 12:00 UTC.
const NOW = new Date('2026-11-18T00:00:00Z');
const errors: string[] = [];
let base = '';
let browser: Browser;
let context: BrowserContext;
let page: Page;
let dir = '';
let stop: () => Promise<void> = async () => {};

async function openPage(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  await p.clock.setFixedTime(NOW);
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
}

before(async () => {
  const doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-agent-e2e-'));
  const main = writeFixture(dir);
  await importFile(main, { doris, db, load });
  // The same session with its failing test run passing, and no sub-agent folder.
  const other = join(dir, `${OTHER}.jsonl`);
  writeFileSync(other, readFileSync(main, 'utf8').replace('"is_error":true', '"is_error":false'));
  await importFile(other, { doris, db, load });
  const meta = await freshMetaDb();
  const webDir = new URL('../dist', import.meta.url).pathname;
  const server = createApp({
    doris, db, auth: { store: new AuthStore(meta.pool), secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool), webDir,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC', acceptDownloads: true });
  page = await openPage(context);
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

const shot = (p: Page, name: string) => (shots ? p.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve());
const total = (text: string) => page.locator('.ag-total', { hasText: new RegExp(`^${text}$`) }).waitFor();
const headers = async () => (await page.locator('.ag-table thead th button').allInnerTexts()).map((t) => t.replace(/[↑↓]/g, '').trim());
const rows = () => page.locator('.ag-table tbody tr:not(.ag-none):not(.ag-more)');
const cells = (row: number) => rows().nth(row).locator('td').allInnerTexts();
const param = (name: string) => new URL(page.url()).searchParams.getAll(name);
const sel = (key: string | RegExp) => page.waitForURL((u) => (typeof key === 'string' ? u.searchParams.get('sel') === key : key.test(u.searchParams.get('sel') ?? '')));
/** The first row's cell in the given column, counted from the first data column. */
const firstCell = (column: number, text: string) => rows().first().locator('td:not(.ag-pick)').nth(column).filter({ hasText: new RegExp(`^${text}$`) }).waitFor();
const lane = (key: string) => page.locator(`.ag-trow[data-key="${key}"]`);
const pane = () => page.locator('.ag-pane');
const main = (kind: 't' | 's' | 'c', n: number) => `${kind}:${MAIN_ID}:${n}`;

async function addFilter(column: string, op: string, value: string) {
  await page.getByRole('button', { name: '+ Add filter' }).click();
  await page.getByLabel('Column', { exact: true }).selectOption(column);
  await page.getByLabel('Comparison', { exact: true }).selectOption(op);
  await page.getByLabel('Value', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
}

test('first run: after the admin account is made, the app opens on Agent trajectories, Sessions', async () => {
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Create admin account' }).waitFor();
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Name').fill('Ada Admin');
  await page.getByLabel('Password').fill('adminpass1');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await page.getByRole('heading', { name: 'Sessions', level: 1 }).waitFor();
  await total('2 sessions');
  const nav = page.getByRole('navigation', { name: 'Main' });
  assert.equal(await nav.locator('.nav-item.active').innerText(), 'Sessions');
  for (const item of ['Steps', 'Messages', 'Search', 'Dashboards']) assert.equal(await nav.getByRole('button', { name: item, exact: true }).count(), 1, item);
  // The time column comes first, written at one width, with the time zone beside the range.
  assert.deepEqual(await headers(), ['Last activity', 'Session', 'Errors', 'First input', 'Last output', 'Turns', 'Steps', 'Tokens']);
  assert.deepEqual((await cells(0)).slice(1), ['2026-11-17 12:00:04', 'Fix the clock test', '1', 'Fix the failing test in tests/clock_test.py 😀', 'Noted: the public API stays unchanged.', '2', '7', '210']);
  assert.deepEqual((await cells(1)).slice(6), ['2', '5', '150']);
  assert.equal(await page.locator('.ag-tz').innerText(), 'UTC');
  assert.equal(await page.getByLabel('Time range').inputValue(), '7d');
  await shot(page, 'a1-sessions');
});

test('Sessions: search, a condition, sort and columns, all kept in the address', async () => {
  const search = page.getByLabel('Search title, first input, last output');
  await search.fill('nothing-says-this');
  await total('0 sessions');
  assert.match(await page.locator('.ag-none').innerText(), /Nothing matches/);
  await search.fill('"public API" unchanged');
  await total('2 sessions');
  assert.deepEqual(param('q'), ['"public API" unchanged']);
  await search.fill('');
  await page.waitForURL((u) => !u.searchParams.has('q'));
  await total('2 sessions');

  await addFilter('tool_errors', 'ge', '1');
  await total('1 session');
  assert.match(await page.locator('.ag-cond').innerText(), /^Errors ≥ 1/);
  assert.deepEqual(param('f'), ['tool_errors:ge:1']);
  // A value that is not a number is refused in the form, and nothing is asked of the server.
  await addFilter('turns', 'ge', 'many');
  assert.equal(await page.getByRole('alert').innerText(), 'Turns is compared with a number.');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Remove this condition' }).click();
  await total('2 sessions');
  assert.deepEqual(param('f'), []);

  await page.locator('.ag-table thead th button', { hasText: 'Steps' }).click();
  await page.locator('th[aria-sort="descending"]', { hasText: 'Steps' }).waitFor();
  await firstCell(6, '7');
  await page.locator('.ag-table thead th button', { hasText: 'Steps' }).click();
  await page.locator('th[aria-sort="ascending"]', { hasText: 'Steps' }).waitFor();
  await firstCell(6, '5');
  assert.deepEqual([param('sort'), param('dir')], [['steps'], ['asc']]);

  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('group', { name: 'Columns' }).getByLabel('Model').check();
  await page.getByRole('group', { name: 'Columns' }).getByLabel('First input').uncheck();
  await page.keyboard.press('Escape');
  assert.deepEqual(await headers(), ['Last activity', 'Session', 'Errors', 'Last output', 'Turns', 'Steps', 'Tokens', 'Model']);
  assert.deepEqual(param('cols'), ['last_event_at,title,tool_errors,last_output,turns,steps,tokens,model']);
  // The address holds the whole state.
  await page.reload();
  await total('2 sessions');
  assert.deepEqual(await headers(), ['Last activity', 'Session', 'Errors', 'Last output', 'Turns', 'Steps', 'Tokens', 'Model']);
  assert.equal(await page.locator('th[aria-sort="ascending"]').innerText(), 'Steps↑');
});

test('the time range: presets ending now, and a custom range typed as the tables write times', async () => {
  await page.goto(`${base}/agents/sessions`);
  await total('2 sessions');
  await page.getByLabel('Time range').selectOption('1h');
  await total('0 sessions');
  assert.match(await page.locator('.ag-none').innerText(), /No sessions in this time range/);
  await page.getByLabel('Time range').selectOption('24h');
  await total('2 sessions');
  await page.getByLabel('Time range').selectOption('custom');
  assert.equal(await page.getByLabel('From', { exact: true }).inputValue(), '2026-11-17 00:00:00');
  await page.getByLabel('From', { exact: true }).fill('2026-11-17 11:00');
  await page.getByLabel('To', { exact: true }).fill('soon');
  await page.getByRole('button', { name: 'Apply' }).click();
  assert.match(await page.getByRole('alert').innerText(), /Use YYYY-MM-DD HH:MM:SS/);
  await page.getByLabel('To', { exact: true }).fill('2026-11-17 11:30:00');
  await page.getByRole('button', { name: 'Apply' }).click();
  // Sessions are kept by their last activity, which was at 12:00:04.
  await total('0 sessions');
  assert.deepEqual([param('from'), param('to')], [[String(Date.UTC(2026, 10, 17, 11))], [String(Date.UTC(2026, 10, 17, 11, 30))]]);
  await page.getByLabel('Time range').selectOption('7d');
  await total('2 sessions');
  assert.deepEqual(param('from'), []);
});

test('SQL: the statements behind the page, one read-only section each, with Copy', async () => {
  await page.goto(`${base}/agents/sessions`);
  await total('2 sessions');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generated SQL' });
  assert.deepEqual(await dialog.locator('.ag-stmt h4 > span:first-child').allInnerTexts(), ['Rows', 'Total']);
  assert.match(await dialog.getByRole('region', { name: 'Rows' }).locator('pre').innerText(), new RegExp(`FROM ${db}\\.agent_sessions s\\nWHERE s\\.kind = 'main'`));
  assert.equal(await dialog.getByRole('button', { name: 'Copy' }).count(), 2);
  await shot(page, 'a2-sql');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
});

test('Export: every matching session as a table or as conversations, with a preview, its SQL and a file', async () => {
  await page.goto(`${base}/agents/sessions?f=tool_errors:ge:1`);
  await total('1 session');
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  assert.match(await dialog.locator('.ag-dialog-note').innerText(), /Every session that matches: Past 7 days · Errors ≥ 1/);
  await dialog.locator('.ag-fmt em', { hasText: '1 row' }).waitFor();
  await dialog.locator('.ag-fmt em', { hasText: /^3 lines at most · 19 message blocks/ }).waitFor();
  assert.match(await dialog.locator('.ag-preview').innerText(), new RegExp(`^last_event_at,session_id,title,[^\\n]+\\n2026-11-17 12:00:04\\.000000,${MAIN_ID},Fix the clock test,1,`));
  await dialog.getByLabel(/Conversations/).check();
  await dialog.locator('.ag-preview', { hasText: '"role":"system"' }).waitFor();
  await dialog.getByRole('button', { name: 'Show the SQL that reads this file' }).click();
  assert.deepEqual(await dialog.locator('.ag-stmt h4 > span:first-child').allInnerTexts(), ['Preview', 'Size', 'Sessions and prompts', 'Messages']);
  await shot(page, 'a3-export');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()]);
  assert.match(download.suggestedFilename(), /^agent-conversations-\d{14}\.jsonl$/);
  const lines = readFileSync(await download.path(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.session_id, l.part, l.messages[0].role]), [[MAIN_ID, 1, 'system'], [MAIN_ID, 2, 'system'], [AGENT_FILE_ID, 1, 'user']]);
  await dialog.getByLabel(/Table/).check();
  const [table] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()]);
  assert.match(table.suggestedFilename(), /^agent-sessions-\d{14}\.csv$/);
  assert.equal(readFileSync(await table.path(), 'utf8').trim().split('\n').length, 2);
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await dialog.waitFor({ state: 'detached' });
});

test('Steps: one row per step; a row opens the session on that step, and the way back keeps the filter', async () => {
  await page.goto(`${base}/agents/sessions`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Steps', exact: true }).click();
  await total('12 steps');
  assert.deepEqual(await headers(), ['Time', 'Session', 'Agent', 'Turn', 'Step', 'Tool calls', 'Status', 'Output', 'Context', 'Latency']);
  await addFilter('status', 'eq', 'failed');
  await total('1 step');
  assert.deepEqual(await cells(0), ['2026-11-17 10:00:01', 'Fix the clock test', 'main', '1', '1', 'Read tests/clock_test.py, Bash pytest tests/clock_test.py', 'failed', "I'll read the test and run it.", '115 tok', '2.0s']);
  await shot(page, 'a4-steps');
  await rows().first().click();
  await sel(main('s', 2));
  await pane().getByRole('heading', { name: /^Step 1/ }).waitFor();
  assert.match(await pane().locator('h2').innerText(), /failed/);
  await page.getByRole('button', { name: '← Steps' }).click();
  await total('1 step');
  assert.deepEqual(param('f'), ['status:eq:failed']);
  // A step that only called a tool wrote no output.
  await page.getByRole('button', { name: 'Remove this condition' }).click();
  await addFilter('calls', 'contains', 'Agent');
  await total('2 steps');
  assert.equal((await cells(0))[7], '');
});

test('Messages: role retrieval; a tool result opens its step, a summary its compaction, a user message its turn', async () => {
  await page.goto(`${base}/agents/sessions`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Messages', exact: true }).click();
  await page.getByRole('heading', { name: 'Messages', level: 1 }).waitFor();
  assert.deepEqual(await headers(), ['Time', 'Session', 'Agent', 'Turn', 'Step', 'Role', 'Kind', 'Tool', 'Status', 'Text', 'Tokens']);
  await addFilter('msg_role', 'eq', 'assistant');
  await total('16 messages');
  assert.deepEqual([...new Set(await page.locator('.ag-table .ag-role').allInnerTexts())], ['assistant']);
  await page.getByRole('button', { name: 'Remove this condition' }).click();

  await addFilter('tool_name', 'eq', 'Bash');
  await addFilter('kind', 'eq', 'tool_result');
  await total('2 messages');
  await page.locator('.ag-table thead th button', { hasText: 'Session' }).click();
  // Both results say FAILED in their text; only one of the two calls failed.
  const failed = rows().filter({ has: page.locator('.ag-pill.bad') });
  assert.equal(await failed.count(), 1);
  await failed.click();
  await sel(main('s', 2));
  await page.getByRole('button', { name: '← Messages' }).click();
  await total('2 messages');

  // One summary per main session; its row opens the compaction that wrote it.
  await page.goto(`${base}/agents/messages?f=kind:eq:summary`);
  await total('2 messages');
  await rows().first().click();
  await sel(/^c:fx-main-000[12]:12$/);
  await pane().getByRole('heading', { name: 'Compaction' }).waitFor();

  await page.goto(`${base}/agents/messages?q=Thanks&f=msg_role:eq:user`);
  await total('2 messages');
  assert.equal(await page.getByLabel('Search message text').inputValue(), 'Thanks');
  await rows().first().click();
  await sel(/^t:fx-main-000[12]:2$/);
  await pane().getByRole('heading', { name: 'Turn 2' }).waitFor();
});

test('the session page: facts, the trajectory as lanes, and a turn as a chat', async () => {
  await page.goto(`${base}/agents/sessions/${MAIN_ID}`);
  await page.getByRole('heading', { name: 'Fix the clock test', level: 1 }).waitFor();
  const facts = await page.locator('.ag-sfacts').innerText();
  assert.match(facts, /^2026-11-17 10:00:00 to 2026-11-17 12:00:04 · 2 turns · 7 steps · 5 tool calls · 1m 10s active · 210 tokens · peak context 115 · claude-opus-5-5 · contexts partly inferred$/);
  assert.deepEqual(await page.locator('.ag-jump button').allInnerTexts(), ['1 failed call', '1 repeated call', '1 compaction', '1 sub-agent']);
  // A small tree opens with its whole structure: turns, steps, the sub-agent as a branch, the compaction.
  assert.deepEqual(await page.locator('.ag-trow').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key)), [
    main('t', 1), main('s', 2), main('s', 5), main('s', 7), `s:${AGENT_FILE_ID}:2`, `s:${AGENT_FILE_ID}:4`, main('s', 10), main('t', 2), main('c', 12), main('s', 13),
  ]);
  assert.match(await lane(main('s', 2)).innerText(), /^1\s*Read tests\/clock_test\.py\s*\+1\s*failed/);
  assert.match(await lane(main('s', 5)).innerText(), /repeated/);
  assert.match(await lane(main('s', 7)).innerText(), /^3\s*Agent Explore\s*2 steps/);
  assert.match(await lane(`s:${AGENT_FILE_ID}:4`).innerText(), /Return the result/);
  assert.match(await lane(main('s', 10)).innerText(), /Reply to the user/);
  assert.match(await lane(main('c', 12)).innerText(), /COMPACTION\s*115 → 115 tokens/i);
  // The sub-agent's rows sit one lane to the right of the step that started them.
  const pad = (key: string) => lane(key).evaluate((e) => getComputedStyle(e).paddingLeft);
  assert.deepEqual([await pad(main('s', 7)), await pad(`s:${AGENT_FILE_ID}:2`)], ['48px', '68px']);

  // The page opens on the first turn: what the user asked on the right, what the assistant answered on the left.
  assert.equal(await lane(main('t', 1)).getAttribute('aria-selected'), 'true');
  await pane().getByRole('heading', { name: 'Turn 1' }).waitFor();
  const input = pane().getByRole('region', { name: 'Input' });
  await input.locator('.ag-msg.user.right .ag-bub', { hasText: 'Fix the failing test in tests/clock_test.py 😀' }).waitFor();
  const output = pane().getByRole('region', { name: 'Output' });
  assert.match(await output.locator('.ag-notice').innerText(), /^4 steps · 1 failed\s*Hide its steps$/);
  assert.equal(await output.locator('.ag-msg.assistant:not(.right) .ag-bub').innerText(), 'Fixed: the clock fixture now uses UTC.');
  await shot(page, 'a5-session');
});

test('a step: what the model saw, what it answered, and what its calls returned', async () => {
  await lane(main('s', 5)).click();
  await sel(main('s', 5));
  await pane().getByRole('heading', { name: /^Step 2/ }).waitFor();
  assert.match(await pane().locator('h2').innerText(), /repeated/);
  assert.match(await pane().locator('.ag-crumbs').innerText(), /^Turn 1$/);
  const input = pane().getByRole('region', { name: 'Input' });
  assert.match(await input.locator('h3').innerText(), /what the model saw · 115 tokens in 7 messages/);
  assert.match(await input.locator('.ag-notice').first().innerText(), /System prompt and 2 tool definitions/);
  // Only what is new in this request shows at first: the assistant's message and the results of its two calls.
  assert.equal(await input.locator('.ag-msg').count(), 2);
  assert.deepEqual(await input.locator('.ag-call code').allInnerTexts(), ['Read tests/clock_test.py', 'Bash pytest tests/clock_test.py']);
  assert.equal(await input.locator('.ag-msg.tool .ag-bub.bad').count(), 1);
  await input.getByRole('button', { name: '2 earlier messages, the same as in the previous request' }).click();
  await input.locator('.ag-mark', { hasText: 'New in this request' }).waitFor();
  assert.equal(await input.locator('.ag-msg.user').count(), 1);
  assert.match(await input.locator('.ag-notice', { hasText: 'Attachment' }).innerText(), /Today is 2026-11-17/);
  const results = pane().getByRole('region', { name: 'Tool results' });
  assert.match(await results.locator('.ag-sig').innerText(), /^Read tests\/clock_test\.py\s*ok · 1\.0s$/);
  assert.match(await results.locator('.ag-foot').innerText(), /The same call was made before\. That result was still in the context\./);
  await shot(page, 'a6-step');

  // The step that started the sub-agent shows its answer under its name; its own steps are a branch on the left.
  await lane(main('s', 7)).click();
  await pane().getByRole('heading', { name: /^Step 3/ }).waitFor();
  const agent = pane().getByRole('region', { name: 'Tool results' }).locator('.ag-msg.agent');
  assert.match(await agent.locator('.ag-by').innerText(), /Sub-agent Explore/);
  assert.match(await agent.locator('.ag-bub').innerText(), /Found src\/clock\.py[\s\S]*2 steps[\s\S]*Hide its steps/);
  await agent.getByRole('button', { name: 'Hide its steps' }).click();
  await lane(`s:${AGENT_FILE_ID}:2`).waitFor({ state: 'detached' });
  await lane(main('s', 7)).locator('.ag-tw').click();
  await lane(`s:${AGENT_FILE_ID}:2`).click();
  await pane().getByRole('heading', { name: /^Step 1/ }).waitFor();
  assert.match(await pane().locator('.ag-crumbs').innerText(), /^Turn 1 › Step 3 · Explore$/);
  assert.match(await pane().locator('.ag-pmeta').innerText(), /context inferred/);
});

test('a compaction, the Jump to buttons, the arrow keys and the SQL of the selection', async () => {
  await page.getByRole('button', { name: '1 compaction' }).click();
  await sel(main('c', 12));
  await pane().getByRole('heading', { name: 'Compaction' }).waitFor();
  assert.match(await pane().locator('.ag-pmeta').innerText(), /in turn 2 · auto$/);
  const replaced = pane().getByRole('region', { name: 'Replaced' });
  await replaced.getByRole('button', { name: '11 messages that later steps no longer see' }).click();
  assert.equal(await replaced.locator('.ag-bub').count() > 5, true);
  assert.match(await pane().getByRole('region', { name: 'Summary' }).locator('.ag-sumcard').innerText(), /Summary: the clock test was fixed by using UTC\./);
  await shot(page, 'a7-compaction');

  await page.getByRole('button', { name: '1 failed call' }).click();
  await sel(main('s', 2));
  await page.getByRole('button', { name: '1 sub-agent' }).click();
  await sel(main('s', 7));
  // Down and up move along the rows; left closes the branch, right opens it again.
  await page.getByRole('tree').focus();
  await page.keyboard.press('ArrowLeft');
  await lane(`s:${AGENT_FILE_ID}:2`).waitFor({ state: 'detached' });
  await page.keyboard.press('ArrowDown');
  await sel(main('s', 10));
  await page.keyboard.press('ArrowUp');
  await sel(main('s', 7));
  await page.keyboard.press('ArrowRight');
  await lane(`s:${AGENT_FILE_ID}:2`).waitFor();

  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generated SQL' });
  assert.deepEqual(await dialog.locator('.ag-stmt h4 > span:first-child').allInnerTexts(), ['Session', 'Turns', 'Marks', 'Steps', 'Step', 'Input', 'Output', 'Prompt']);
  await page.keyboard.press('Escape');
  // A place that does not exist says so on the right; the lanes stay.
  await page.goto(`${base}/agents/sessions/${MAIN_ID}?sel=${encodeURIComponent(main('s', 3))}`);
  assert.equal(await pane().getByRole('alert').innerText(), 'no such model call');
  assert.equal(await page.locator('.ag-trow').count(), 10);
  await page.goto(`${base}/agents/sessions/nobody`);
  assert.equal(await page.getByRole('alert').innerText(), 'no such session');
});

test('Compare: two ticked sessions as two rows of facts, then their lanes side by side', async () => {
  await page.goto(`${base}/agents/sessions`);
  await total('2 sessions');
  const compare = page.getByRole('button', { name: /^Compare/ });
  assert.equal(await compare.isDisabled(), true);
  await rows().nth(0).getByRole('checkbox').check();
  assert.equal(await compare.innerText(), 'Compare 1/2');
  await rows().nth(1).getByRole('checkbox').check();
  assert.equal(await compare.innerText(), 'Compare 2/2');
  await compare.click();
  await page.getByRole('heading', { name: 'Compare sessions', level: 1 }).waitFor();
  const facts = page.getByRole('table', { name: 'The two sessions' });
  await facts.waitFor();
  const row = (i: number) => facts.locator('tbody tr').nth(i).locator('td').allInnerTexts();
  assert.deepEqual((await row(0)).slice(0, 7), ['A', 'Fix the clock test', 'claude-opus-5-5', '2026-11-17 10:00:00', '2', '7', '1']);
  assert.deepEqual((await row(1)).slice(4, 8), ['2', '5', '0', '0']);
  assert.deepEqual((await row(2)).slice(0, 6), ['B compared with A', 'same', '', '0', '−2', '−1']);
  // Two small sessions open with every pair of turns open: four pairs of steps, then the compaction and one more.
  await page.locator('.ag-crow .ag-trow.cut').first().waitFor();
  assert.equal(await page.locator('.ag-crow').count(), 8);
  // Only the first pair differs: the same calls, but the command failed in A.
  assert.equal(await page.locator('.ag-crow.dif').count(), 1);
  assert.match(await page.locator('.ag-crow.dif .ag-trow').first().innerText(), /Read Bash[\s\S]*failed/);
  assert.doesNotMatch(await page.locator('.ag-crow.dif .ag-trow').last().innerText(), /failed/);
  await shot(page, 'a8-compare');
  await page.getByRole('button', { name: 'Swap A and B' }).click();
  await page.waitForURL((u) => u.searchParams.get('a') === OTHER);
  await facts.locator('tbody tr').nth(2).locator('td', { hasText: '+2' }).waitFor();
  // A step opens in its own session, and the way back returns to the comparison.
  await page.locator('.ag-crow.dif .ag-trow').last().click();
  await sel(main('s', 2));
  await page.getByRole('button', { name: '← Compare' }).click();
  await page.getByRole('heading', { name: 'Compare sessions', level: 1 }).waitFor();
  await page.locator('.ag-crow .ag-trow.cut').first().waitFor();
  // A closed pair of turns closes on both sides at once.
  await page.locator('.ag-crow .ag-trow.turn').first().click();
  await page.locator('.ag-crow .ag-trow.closed').first().waitFor();
  assert.equal(await page.locator('.ag-crow').count(), 4);
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  assert.deepEqual(await page.getByRole('dialog', { name: 'Generated SQL' }).locator('.ag-stmt h4 > span:first-child').allInnerTexts(), ['Sessions', 'Turns', 'Steps of turn 2']);
  await page.keyboard.press('Escape');
});

test('the dark theme and a 400 px window', async () => {
  const state = await context.storageState();
  const dark = await openPage(await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC', colorScheme: 'dark', storageState: state }));
  await dark.goto(`${base}/agents/sessions/${MAIN_ID}?sel=${encodeURIComponent(main('s', 5))}`);
  await dark.locator('.ag-pane .ag-io').first().waitFor();
  // Dark surfaces, light text, and the lane still set off from its background.
  const colors = await dark.evaluate(() => {
    const css = (sel: string, prop: 'backgroundColor' | 'color' | 'fill') => getComputedStyle(document.querySelector(sel)!)[prop];
    return [css('.ag-spage', 'backgroundColor'), css('.ag-shead h1', 'color'), css('.ag-rl', 'fill'), css('.ag-msg.assistant .ag-bub', 'backgroundColor')];
  });
  assert.deepEqual(colors, ['rgb(20, 24, 29)', 'rgb(227, 231, 236)', 'rgb(71, 69, 111)', 'rgb(38, 44, 55)']);
  await shot(dark, 'a9-dark');
  await dark.goto(`${base}/agents/compare?a=${MAIN_ID}&b=${OTHER}`);
  await dark.locator('.ag-crow.dif').waitFor();
  await shot(dark, 'a10-dark-compare');
  await dark.context().close();

  const phone = await openPage(await browser.newContext({ viewport: { width: 400, height: 800 }, timezoneId: 'UTC', storageState: state }));
  const fits = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await phone.goto(`${base}/agents/sessions`);
  await phone.locator('.ag-total', { hasText: '2 sessions' }).waitFor();
  assert.equal(await fits(), true);
  // The navigation is a rail of icons here, so the page itself offers its sibling pages.
  await phone.getByRole('group', { name: 'Pages' }).getByRole('button', { name: 'Messages' }).click();
  await phone.getByRole('heading', { name: 'Messages', level: 1 }).waitFor();
  assert.equal(await fits(), true);
  await shot(phone, 'a11-phone-messages');
  await phone.goto(`${base}/agents/sessions/${MAIN_ID}?sel=${encodeURIComponent(main('s', 5))}`);
  await phone.locator('.ag-pane .ag-io').first().waitFor();
  assert.equal(await fits(), true);
  // The lanes sit above the chat.
  const [outline, chat] = await Promise.all([phone.locator('.ag-outline').boundingBox(), phone.locator('.ag-pane').boundingBox()]);
  assert.ok(outline!.y + outline!.height <= chat!.y + 1 && outline!.width > 300 && chat!.width > 300);
  await shot(phone, 'a12-phone-session');
  await phone.goto(`${base}/agents/compare?a=${MAIN_ID}&b=${OTHER}`);
  await phone.locator('.ag-crow.dif').waitFor();
  assert.equal(await fits(), true);
  await phone.context().close();
});

test('no page raised an error', () => {
  assert.deepEqual(errors, []);
});
