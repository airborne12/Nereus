// Browser test of the Sequences page against a live Doris: the hand-written fixture and two
// generated sessions of tool calls. Starts the API service in-process (serving web/dist) and walks
// the drawing of what happens next, a pattern and its matches, and a match opened in its session,
// in headless Chromium. Numbers on the page are compared with plain counts read from Doris.
//
//   npm run build && DORIS_BE_HTTP_URL=http://127.0.0.1:8040 SHOTS=/tmp/shots node --test e2e/sequences.e2e.ts

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { importFile } from '../../server/src/cli/import-transcripts.ts';
import { AuthStore } from '../../server/src/control/auth/store.ts';
import { ContentStore } from '../../server/src/control/content/store.ts';
import { Doris, configFromEnv } from '../../server/src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../../server/src/db/stream-load.ts';
import { IngestKeys } from '../../server/src/rum/http.ts';
import { createApp } from '../../server/src/server.ts';
import { AGENT_FILE_ID, MAIN_ID, writeFixture } from '../../server/test/fixtures/claude-transcript.ts';
import { SEQ_A, SEQ_B, writeSequences } from '../../server/test/fixtures/sequence-transcript.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';
import { applySchemaFile } from '../../server/test/schema-helper.ts';

const shots = process.env.SHOTS;
const db = `nereus_seq_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
/** The browser's clock: the afternoon of the day the fixtures run on. */
const NOW = Date.parse('2026-11-17T13:00:00Z');
const errors: string[] = [];
let doris: Doris;
let browser: Browser;
let page: Page;
let base = '';
let dir = '';
let stop: () => Promise<void> = async () => {};

before(async () => {
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-seq-e2e-'));
  for (const file of [writeFixture(dir), ...writeSequences(dir)]) await importFile(file, { doris, db, load });
  const meta = await freshMetaDb();
  const auth = new AuthStore(meta.pool);
  await auth.setup('admin@example.com', 'Ada Admin', 'adminpass1');
  const webDir = new URL('../dist', import.meta.url).pathname;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool), webDir });
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
const count = async (where: string) => Number((await doris.query(`SELECT count(*) AS n FROM ${db}.agent_events WHERE ${where}`))[0]!.n);
const total = (text: string | RegExp) => page.locator('.ag-total', { hasText: typeof text === 'string' ? new RegExp(`^${text}$`) : text }).waitFor();
const param = (name: string) => new URL(page.url()).searchParams.get(name);
const pattern = () => JSON.parse(param('p') ?? 'null');
const chips = async () => (await page.locator('.ag-pel').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
const links = async () => (await page.locator('.ag-plink').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
const heads = async () => (await page.locator('.ag-matches thead th button').allInnerTexts()).map((t) => t.replace(/[↑↓]/g, '').trim());
const rows = () => page.locator('.ag-matches tbody tr:not(.ag-none):not(.ag-more)');
const pills = () => page.locator('.ag-pn');
const urlOf = (steps: unknown) => `${base}/agents/sequences?p=${encodeURIComponent(JSON.stringify(steps))}`;
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : word.endsWith('ch') ? 'es' : 's'}`;

test('Sequences is a page of the navigation and opens on what follows a failed call', async () => {
  await page.getByRole('button', { name: 'Sequences', exact: true }).click();
  await page.waitForURL(`${base}/agents/sequences`);
  await page.getByRole('heading', { name: 'Sequences', level: 1 }).waitFor();
  const failed = await count("kind = 'tool_call' AND status = 'error'");
  assert.ok(failed > 20, `${failed} failed calls in the fixtures`);
  await total(plural(failed, 'time'));
  assert.deepEqual(await page.locator('.ag-ph').allTextContents(), ['Starts with', 'Next', 'Then', 'Then']);
  assert.match((await pills().first().textContent())!, new RegExp(`Failed call.*${failed}$`));
  assert.ok(await pills().count() > 6, 'the tree has branches');
  assert.ok(await page.locator('.ag-pn.dim').count() > 0, 'rare branches are drawn as one');
  assert.ok(await page.locator('.ag-pn.bad').count() > 1, 'a failed call after the first is red');
  // Shares of the branches of the start add up to all of it.
  const next = await page.evaluate(async () => (await fetch(`/api/agents/sequences/next${location.search || '?'}&from=2026-11-10T13:00:00Z&to=2026-11-17T13:00:00Z`)).json());
  assert.equal(next.kids.reduce((n: number, k: { times: number }) => n + k.times, 0) + (next.other?.times ?? 0), failed);
  await shot('seq-01-paths');
});

test('the drawing starts from another event; its statements are shown', async () => {
  await page.getByLabel('Start from', { exact: true }).selectOption({ label: 'a call of Read' });
  await page.waitForURL((u) => u.searchParams.get('start') === 'tool:Read');
  await total(plural(await count("kind = 'tool_call' AND name = 'Read'"), 'time'));
  assert.match((await pills().first().textContent())!, /^Read/);
  await page.getByLabel('Start from', { exact: true }).selectOption({ label: 'a user input' });
  await total(plural(await count("kind = 'user_input'"), 'time'));
  assert.ok(await page.locator('.ag-pn.ev').count() >= 1, 'an event that is not a tool call has a dark pill');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.deepEqual(await dialog.locator('.ag-stmt h4 > span').allInnerTexts(), ['Paths', 'Tools']);
  assert.match(await dialog.locator('.ag-stmt pre').first().innerText(), /lead\(k, 1\) OVER \(PARTITION BY session_id ORDER BY pos\)/);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  // A range that holds nothing says so.
  await page.goto(`${base}/agents/sequences?from=${Date.parse('2026-01-01T00:00:00Z')}&to=${Date.parse('2026-01-02T00:00:00Z')}`);
  await page.getByText('No such event in the time range.').waitFor();
  await total('0 times');
});

test('a path of the drawing opens as a pattern, with as many matches as the path has runs', async () => {
  await page.goto(`${base}/agents/sequences?start=tool%3ARead`);
  await total(/times$/);
  const tree = await page.evaluate(async () => (await fetch('/api/agents/sequences/next?start=tool%3ARead&from=2026-11-10T13:00:00Z&to=2026-11-17T13:00:00Z')).json());
  const first = tree.kids[0];
  const then = first.kids[0];
  // The third pill is the commonest event after the commonest event after a Read.
  await pills().nth(2).click();
  await page.getByRole('heading', { name: 'Pattern', level: 1 }).waitFor();
  // An event of the drawing as the step that finds it again, and as the page words it.
  const WORD: Record<string, string> = { u: 'User input', r: 'Reply', x: 'Compaction' };
  const call = (key: string) => key[0] === 'c' || key[0] === 'f';
  const step = (key: string) => (call(key) ? { kind: 'call', tool: key.slice(2), status: key[0] === 'f' ? 'failed' : 'ok', link: 'next' } : { kind: { u: 'user', r: 'reply', x: 'compaction' }[key[0]!], link: 'next' });
  const chip = (key: string) => (call(key) ? `${key.slice(2)} ${key[0] === 'f' ? 'failed' : 'ok'}` : WORD[key[0]!]);
  const head = (key: string) => (call(key) ? key.slice(2) : WORD[key[0]!]);
  assert.deepEqual(pattern(), [{ kind: 'call', tool: 'Read' }, step(first.key), step(then.key)]);
  await total(new RegExp(`^${plural(then.times, 'match')} in \\d sessions?$`));
  assert.deepEqual(await chips(), ['1 Read', `2 ${chip(first.key)}`, `3 ${chip(then.key)}`]);
  assert.deepEqual(await heads(), ['Time', 'Session', 'Agent', 'Turn', '1 · Read', `2 · ${head(first.key)}`, `3 · ${head(then.key)}`, 'Span']);
  assert.equal(await rows().count(), Math.min(100, then.times));
  assert.match((await rows().first().locator('td').allInnerTexts()).join(' | '), /^2026-11-17 09:\d\d:\d\d \| Sequences fx-seq-000\d \| main \| \d+ \| \d+ ?Read .* \| 3$/);
  await shot('seq-02-pattern');
  // The drawing is one step back in the history; the back button of the page goes there too.
  await page.goBack();
  await page.getByRole('heading', { name: 'Sequences', level: 1 }).waitFor();
  assert.equal(param('p'), null);
  await page.goForward();
  await page.getByRole('button', { name: '← Sequences' }).click();
  await page.getByRole('heading', { name: 'Sequences', level: 1 }).waitFor();
  assert.equal(param('start'), 'tool:Read');
});

test('a pattern is written step by step: an example, a step changed, added and removed', async () => {
  await page.goto(`${base}/agents/sequences?start=tool%3ARead`);
  await page.getByRole('button', { name: 'Write a pattern' }).click();
  await page.getByRole('heading', { name: 'Pattern', level: 1 }).waitFor();
  assert.deepEqual(pattern(), [{ kind: 'call', tool: 'Read' }]);
  await page.getByLabel('Examples', { exact: true }).selectOption({ label: 'Edit, failed test, edit the same file' });
  await page.waitForURL((u) => (u.searchParams.get('p') ?? '').includes('"same":1'));
  assert.deepEqual(await chips(), ['1 Edit', '2 Bash failed target has "test"', '3 Edit same target as 1']);
  assert.deepEqual(await links(), ['→ next', '→ next']);
  await total(/^\d+ match(es)? in \d sessions?$/);

  // Step 2 loses its status and follows as any later event.
  await page.locator('.ag-pel').nth(1).click();
  const form = page.getByRole('form', { name: 'Step 2' });
  assert.deepEqual(await form.getByLabel('Tool', { exact: true }).locator('option').allInnerTexts(), ['any', ...(await doris.query(`SELECT name FROM ${db}.agent_events WHERE kind = 'tool_call' GROUP BY name ORDER BY count(*) DESC, name`)).map((r) => String(r.name))]);
  await form.getByLabel('Status', { exact: true }).selectOption('');
  await form.getByLabel('follows step 1', { exact: true }).selectOption('later');
  await form.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL((u) => !(u.searchParams.get('p') ?? '').includes('failed'));
  assert.deepEqual(await chips(), ['1 Edit', '2 Bash target has "test"', '3 Edit same target as 1']);
  assert.deepEqual(await links(), ['⇢ later', '→ next']);
  assert.equal(await form.count(), 0, 'the form closes when the step is applied');

  // A fourth step: a reply, any time later. Only a tool call is asked for a tool.
  await page.getByRole('button', { name: '+ Add step' }).click();
  const added = page.getByRole('form', { name: 'Step 4' });
  await added.getByLabel('Event', { exact: true }).selectOption('reply');
  assert.equal(await added.getByLabel('Tool', { exact: true }).count(), 0);
  await added.getByLabel('Text has', { exact: true }).fill('Done');
  await added.getByLabel('follows step 3', { exact: true }).selectOption('later');
  assert.deepEqual(await added.getByLabel('Same text as', { exact: true }).locator('option').allInnerTexts(), ['no step', 'step 1', 'step 2', 'step 3']);
  await added.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL((u) => (u.searchParams.get('p') ?? '').includes('reply'));
  assert.deepEqual((await chips())[3], '4 Reply text has "Done"');
  assert.deepEqual((await heads()).slice(4), ['1 · Edit', '2 · Bash', '3 · Edit', '4 · Reply', 'Span']);
  await total(/^\d+ match(es)? in \d sessions?$/);
  assert.match((await rows().first().locator('td').nth(7).innerText()), /Reply\s+Done\./);

  // Without step 1, the step that shared its target shares none, and the others move up.
  await page.locator('.ag-pel').first().click();
  await page.getByRole('form', { name: 'Step 1' }).getByRole('button', { name: 'Remove' }).click();
  await page.waitForURL((u) => !(u.searchParams.get('p') ?? '').includes('same'));
  assert.deepEqual(await chips(), ['1 Bash target has "test"', '2 Edit', '3 Reply text has "Done"']);
  assert.deepEqual(pattern(), [{ kind: 'call', tool: 'Bash', has: 'test' }, { kind: 'call', tool: 'Edit', link: 'next' }, { kind: 'reply', has: 'Done', link: 'later' }]);
  await shot('seq-03-written');
});

test('the table of matches sorts from its headers and reads 100 rows at a time', async () => {
  await page.goto(urlOf([{ kind: 'call', tool: 'Read' }, { kind: 'call', tool: 'Bash', link: 'later' }]));
  await total(/^\d+ matches in 3 sessions$/);
  const span = async () => (await rows().locator('td:last-child').allInnerTexts()).map(Number);
  await page.locator('.ag-matches thead th button', { hasText: 'Span' }).click();
  await page.waitForURL((u) => u.searchParams.get('sort') === 'span');
  await page.locator('.ag-matches th[aria-sort="descending"]', { hasText: 'Span' }).waitFor();
  await page.locator('.ag-grid:not(.stale)').waitFor();
  assert.deepEqual(await span(), [...await span()].sort((a, b) => b - a));
  assert.ok((await span())[0]! > 3);
  await page.locator('.ag-matches thead th button', { hasText: 'Span' }).click();
  await page.waitForURL((u) => u.searchParams.get('dir') === 'asc');
  await page.locator('.ag-grid:not(.stale)').waitFor();
  assert.deepEqual(await span(), [...await span()].sort((a, b) => a - b));
  // A pattern every tool call meets has more matches than one page.
  await page.goto(urlOf([{ kind: 'call' }]));
  const calls = await count("kind = 'tool_call'");
  assert.ok(calls > 100);
  await total(new RegExp(`^${plural(calls, 'match')} in \\d sessions$`));
  assert.equal(await rows().count(), 100);
  await page.getByRole('button', { name: `Show 100 more of ${calls - 100}` }).click();
  await page.locator('.ag-matches tbody tr:not(.ag-none):not(.ag-more)').nth(199).waitFor();
});

test('a match opens its session with its events marked, and the page leads back to the pattern', async () => {
  const steps = [{ kind: 'reply', has: 'should i' }, { kind: 'user', link: 'next' }, { kind: 'call', tool: 'Bash', link: 'later' }];
  await page.goto(`${urlOf(steps)}&sort=time&dir=asc`);
  await total(/^\d+ matches in 2 sessions$/);
  assert.match(await rows().first().locator('td').nth(4).innerText(), /Reply\s+.*Should I/);
  const address = page.url();
  await rows().first().click();
  await page.waitForURL(/\/agents\/sessions\/fx-seq-000\d\?/);
  const session = new URL(page.url()).pathname.split('/').pop()!;
  assert.ok([SEQ_A, SEQ_B].includes(session));
  const marks = param('marks')!;
  assert.match(marks, new RegExp(`^${session};s\\d+\\.\\d+\\.\\d+,t\\d+,s\\d+\\.\\d+\\.\\d+$`));
  assert.equal(param('sel'), `s:${session}:${marks.split(';')[1]!.split(',')[0]!.split('.')[2]}`);
  await page.getByText('3 events of a pattern match marked on the left.').waitFor();
  // The reply, the turn of the next input and the step of the command: three marked rows, the first selected.
  await page.locator('.ag-trow.mk.sel').waitFor();
  await page.locator('.ag-trow.mk').nth(2).waitFor();
  assert.equal(await page.locator('.ag-trow.mk').count(), 3);
  assert.equal(await page.locator('.ag-trow.turn.mk').count(), 1);
  await page.locator('.ag-pane').getByRole('heading', { name: /^Step \d+/ }).waitFor();
  assert.match(await page.locator('.ag-pane').innerText(), /Should I/);
  await shot('seq-04-marked');
  // Selecting another row keeps the marks.
  await page.locator('.ag-trow.turn.mk').click();
  await page.waitForURL((u) => (u.searchParams.get('sel') ?? '').startsWith('t:'));
  assert.equal(param('marks'), marks);
  assert.equal(await page.locator('.ag-trow.mk').count(), 3);
  await page.getByRole('button', { name: '← Pattern' }).click();
  await page.waitForURL(address);
  await total(/^\d+ matches in 2 sessions$/);
});

test('a match inside a sub-agent marks the row that stands for the sub-agent', async () => {
  // The sub-agent of the first fixture: its input, then its search.
  await page.goto(urlOf([{ kind: 'user', has: 'clock helpers' }, { kind: 'call', tool: 'Grep', link: 'next' }]));
  await total('1 match in 1 session');
  assert.equal((await rows().first().locator('td').nth(2).innerText()).trim(), 'Explore');
  await rows().first().click();
  await page.waitForURL((u) => u.pathname === `/agents/sessions/${MAIN_ID}` && u.searchParams.get('marks') !== null);
  assert.equal(param('sel'), `t:${AGENT_FILE_ID}:1`);
  await page.getByText('2 events of a pattern match marked on the left.').waitFor();
  // The input of a sub-agent is its only turn; the step that started the sub-agent stands for it, and is selected.
  const spawn = page.locator('.ag-trow.step.mk.sel');
  await spawn.waitFor();
  assert.match((await spawn.innerText()).replace(/\s+/g, ' '), /Agent Explore/);
  await page.locator('.ag-trow.step.mk', { hasText: 'Grep' }).waitFor();
  assert.equal(await page.locator('.ag-trow.mk').count(), 2);
  await page.locator('.ag-pane').getByRole('heading', { name: 'Explore: turn 1' }).waitFor();
});

test('nothing matching and a refused request are said plainly', async () => {
  await page.goto(urlOf([{ kind: 'call', tool: 'Nothing' }]));
  await total('0 matches in 0 sessions');
  await page.getByText('No events follow one another this way in the time range.').waitFor();
  await page.route('**/api/agents/sequences/match', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'a pattern has 1 to 6 steps' }) }));
  await page.goto(urlOf([{ kind: 'call', tool: 'Read' }]));
  await page.getByRole('alert').filter({ hasText: 'a pattern has 1 to 6 steps' }).waitFor();
  // A request that failed found nothing out: the page does not say that nothing matches.
  assert.equal(await page.getByText('No events follow one another this way').count(), 0);
  await page.unroute('**/api/agents/sequences/match');
  // While a pattern with other columns is read, the table says it is loading.
  await page.goto(urlOf([{ kind: 'call', tool: 'Read' }]));
  await total(/^\d+ matches in \d sessions$/);
  await page.route('**/api/agents/sequences/match', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByRole('button', { name: '+ Add step' }).click();
  await page.locator('.ag-matches tr.ag-none', { hasText: 'Loading…' }).waitFor();
  assert.equal(await page.getByText('No events follow one another this way').count(), 0);
  await page.unroute('**/api/agents/sequences/match');
  // An address that spells a pattern wrongly shows the drawing.
  await page.goto(`${base}/agents/sequences?p=nonsense`);
  await page.getByRole('heading', { name: 'Sequences', level: 1 }).waitFor();
  await total(/times$/);
});

test('the dark theme and a 400 px window', async () => {
  const context = await browser.newContext({ viewport: { width: 400, height: 800 }, timezoneId: 'UTC', colorScheme: 'dark', storageState: await page.context().storageState() });
  const small = await context.newPage();
  await small.clock.setFixedTime(NOW);
  small.on('pageerror', (e) => errors.push(e.message));
  await small.goto(`${base}/agents/sequences`);
  await small.locator('.ag-pn').first().waitFor();
  // The drawing is wider than the window: its box scrolls, the page does not.
  assert.ok(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.ok(await small.locator('.ag-pathbox').evaluate((el) => el.scrollWidth > el.clientWidth));
  if (shots) await small.screenshot({ path: `${shots}/seq-05-dark-400-paths.png` });
  await small.goto(urlOf([{ kind: 'call', tool: 'Edit' }, { kind: 'call', tool: 'Bash', status: 'failed', has: 'test', link: 'next' }, { kind: 'call', tool: 'Edit', same: 1, link: 'later' }]));
  await small.locator('.ag-total', { hasText: /match/ }).waitFor();
  assert.ok(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(await small.locator('.ag-pel').count(), 3);
  if (shots) await small.screenshot({ path: `${shots}/seq-06-dark-400-pattern.png` });
  await context.close();
});

test('no page raised an error', () => {
  assert.deepEqual(errors, []);
});
