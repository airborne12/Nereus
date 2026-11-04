// Browser test of the web UI against a live Doris loaded by bench/otelgen.py and a fresh
// PostgreSQL metadata database. Starts the API service in-process (serving web/dist), drives
// headless Chromium from first-run setup through search, the side panel, settings and logout.
//
//   npm run build && DORIS_PORT=9730 DORIS_DB=otel_bench SHOTS=/tmp/shots npm run e2e

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { AuthStore } from '../../server/src/auth/store.ts';
import { Doris, configFromEnv } from '../../server/src/db.ts';
import { createApp } from '../../server/src/server.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';

const shots = process.env.SHOTS;
let base = '';
let browser: Browser;
let page: Page;
let stop: () => Promise<void> = async () => {};

before(async () => {
  const doris = new Doris(configFromEnv());
  const meta = await freshMetaDb();
  const webDir = new URL('../dist', import.meta.url).pathname;
  const auth = { store: new AuthStore(meta.pool), secureCookie: false };
  const server = createApp({ doris, db: process.env.DORIS_DB ?? 'otel_bench', auth, webDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  if (shots) mkdirSync(shots, { recursive: true });
  stop = async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    await doris.close();
    await meta.drop();
  };
});
after(() => stop());

const shot = (name: string) => (shots ? page.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve());
const rows = () => page.locator('table.results tbody tr');
const where = () => page.getByLabel('Search query');
const settled = () => page.locator('.count', { hasText: /results$/ }).waitFor({ timeout: 60_000 });
const total = async () => Number((await page.locator('.count').innerText()).replace(/\D/g, ''));
const column = (i: number) => page.locator(`table.results tbody tr td:nth-child(${i})`).allInnerTexts();
const headers = () => page.locator('table.results thead th .th').allInnerTexts();
async function run(text: string) {
  await where().fill(text);
  await where().press('Escape');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.waitForFunction((t) => (new URLSearchParams(location.search).get('where') ?? '') === t, text);
  await settled();
}
async function open(qs: string) {
  await page.goto(`${base}/search?${qs}`);
  await settled();
}

test('first run asks for an admin account, then opens search on Live Tail', async () => {
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Create admin account' }).waitFor();
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Name').fill('Ada Admin');
  await page.getByLabel('Password').fill('adminpass1');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await page.getByLabel('Search query').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Time Range' }).innerText(), 'Live Tail');
  assert.equal(await page.locator('.nav-item.active').innerText(), 'Search');
  for (const item of ['Saved searches', 'Chart explorer', 'Alerts', 'Client sessions', 'Service map', 'Dashboards', 'Team settings']) {
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: item }).count(), 1, item);
  }
});

test('results, histogram and the filter panel load together', async () => {
  await open('source=logs&t=7d');
  assert.equal(await rows().count(), 200);
  assert.ok(await total() > 200);
  assert.ok(await page.locator('.histogram rect').count() > 0);
  assert.deepEqual(await headers(), ['timestamp (UTC)', 'service_name', 'severity_text', 'body']);
  const panel = page.getByLabel('Filters');
  await panel.getByRole('region', { name: 'service_name' }).waitFor();
  assert.deepEqual((await panel.locator('.facet-title span').allInnerTexts()).slice(0, 2), ['service_name', 'severity_text']);
  await shot('1-search');
});

test('Lucene with completion, then the same search in SQL gives the same count', async () => {
  await where().click();
  await where().fill('lev');
  await page.getByRole('option', { name: /^level/ }).click();
  await page.getByRole('option', { name: /^ERROR/ }).click();
  assert.equal(await where().inputValue(), 'level:"ERROR" ');
  await where().press('Enter');
  await page.waitForURL(/where=level/);
  await settled();
  const lucene = await total();
  assert.ok((await column(3)).every((l) => l === 'ERROR'));
  await page.getByLabel('Query language').selectOption('sql');
  await run("severity_text = 'ERROR'");
  assert.match(page.url(), /lang=sql/);
  assert.equal(await total(), lucene);
  await run('severity_text = ; nope');
  assert.match(await page.getByRole('alert').innerText(), /single SQL expression/);
  await page.getByLabel('Query language').selectOption('lucene');
  await run('');
});

test('filter panel: include, exclude and remove, shown as pills', async () => {
  const svc = page.getByLabel('Filters').getByRole('region', { name: 'service_name' });
  const all = await total();
  await svc.getByRole('checkbox', { name: 'service_name = payment' }).check();
  await page.waitForURL(/filters=/);
  await settled();
  const payment = await total();
  assert.ok(payment > 0 && payment < all);
  assert.deepEqual([...new Set(await column(2))], ['payment']);
  assert.match(await page.getByLabel('Active filters').innerText(), /service_name\s*=\s*payment/);
  await svc.getByRole('checkbox', { name: 'service_name = cart' }).check();
  await settled();
  assert.deepEqual([...new Set(await column(2))].sort(), ['cart', 'payment']);
  // Exclude on the same field replaces the include filter.
  const row = svc.locator('.facet-value', { hasText: 'frontend' });
  await row.hover();
  await row.getByRole('button', { name: 'Exclude' }).click();
  await settled();
  assert.ok(!(await column(2)).includes('frontend'));
  assert.ok(await total() < all);
  assert.match(await page.getByLabel('Active filters').innerText(), /service_name\s*≠\s*frontend/);
  await page.getByRole('button', { name: 'Remove filter service_name' }).click();
  await settled();
  assert.equal(await total(), all);
  await shot('2-filters');
});

test('SELECT picks the columns; a column can be removed from its header', async () => {
  await page.getByLabel('SELECT').fill('timestamp, level, k8s.pod.name, body');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.waitForURL(/select=/);
  await settled();
  assert.deepEqual(await headers(), ['timestamp (UTC)', 'level', 'k8s.pod.name', 'body']);
  assert.ok((await column(3)).every((v) => /^[a-z-]+-\d$/.test(v)), 'pod names in the k8s.pod.name column');
  await page.locator('table.results thead th', { hasText: 'k8s.pod.name' }).hover();
  await page.getByRole('button', { name: 'Remove column k8s.pod.name' }).click();
  await settled();
  assert.deepEqual(await headers(), ['timestamp (UTC)', 'level', 'body']);
});

test('traces: ORDER BY duration, the default duration column, Root Spans Only', async () => {
  await open(`source=traces&t=7d&orderBy=${encodeURIComponent('duration DESC')}`);
  assert.deepEqual(await headers(), ['timestamp (UTC)', 'service_name', 'status_code', 'round(duration / 1000, 1)', 'span_name']);
  const ms = (await column(4)).map(Number);
  assert.deepEqual(ms, [...ms].sort((a, b) => b - a));
  await page.getByLabel('Filters').getByText('Root Spans Only').click();
  await settled();
  assert.match(await page.getByLabel('Active filters').innerText(), /is_root\s*=\s*1/);
});

test('side panel: overview, column values, trace with logs, surrounding context, add a filter', async () => {
  await open(`source=logs&t=7d&where=${encodeURIComponent('level:error "timeout after"')}`);
  await rows().first().click();
  const panel = page.getByLabel('Event details');
  await panel.getByRole('tab', { name: 'Overview', selected: true }).waitFor();
  assert.match(await panel.innerText(), /Top Level Attributes[\s\S]*Resource Attributes[\s\S]*Log Attributes/);
  await shot('3-overview');
  await panel.getByRole('tab', { name: 'Column Values' }).click();
  await panel.getByLabel('Search properties by key or value').fill('pod');
  assert.match(await panel.locator('.kvs').innerText(), /resource_attributes\.k8s\.pod\.name/);
  await panel.getByRole('tab', { name: 'Trace' }).click();
  await panel.locator('.wf-row').first().waitFor();
  assert.match(await panel.locator('.trace-summary').innerText(), /\d+ spans, \d+ errors/);
  assert.ok(await panel.locator('.wf-log').count() >= 1, 'log lines are interleaved under their spans');
  await panel.locator('.wf-row').first().click();
  await panel.getByLabel('Span details', { exact: true }).waitFor();
  await shot('4-trace');
  await panel.getByRole('tab', { name: 'Surrounding Context' }).click();
  await panel.locator('tr.this-event').waitFor();
  assert.match(await panel.locator('tr.this-event').innerText(), /This Event/);
  await panel.getByRole('tab', { name: 'Overview' }).click();
  const pod = panel.locator('.kv', { hasText: 'k8s.pod.name' });
  await pod.hover();
  await pod.getByRole('button', { name: 'Filter k8s.pod.name' }).click();
  await settled();
  assert.match(await page.getByLabel('Active filters').innerText(), /k8s\.pod\.name\s*=/);
  await panel.locator('.drawer-title').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('Event details').count(), 0, 'Esc closes the panel');
});

test('scrolling to the end loads the next page', async () => {
  await open('source=logs&t=7d');
  assert.equal(await rows().count(), 200);
  await page.locator('.table-wrap').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForFunction(() => document.querySelectorAll('table.results tbody tr').length > 200);
  assert.equal(await rows().count(), 400);
});

test('histogram drag zooms; Generated SQL shows what ran', async () => {
  const box = (await page.locator('.histogram svg').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForURL(/from=\d+&to=\d+/);
  await settled();
  assert.match(await page.getByRole('button', { name: 'Time Range' }).innerText(), /\d{4}-\d{2}-\d{2} .* – /);
  await page.getByRole('button', { name: 'Show Generated SQL' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generated SQL' });
  const sql = await dialog.innerText();
  assert.match(sql, /SELECT \* FROM otel_bench\.otel_logs WHERE timestamp >= /);
  assert.match(sql, /GROUP BY t, g/);
  await dialog.getByRole('button', { name: 'Close' }).click();
});

test('Event Patterns groups the log lines', async () => {
  await open('source=logs&t=7d');
  await page.getByRole('tab', { name: 'Event Patterns' }).click();
  await page.locator('table.patterns tbody tr').first().waitFor();
  const patterns = await page.locator('table.patterns tbody td.c-body').allInnerTexts();
  assert.ok(patterns.some((p) => p.includes('<num>')));
  assert.ok(patterns.length < 30, `${patterns.length} patterns for 8 log templates`);
  assert.match(await page.locator('table.patterns tbody td.c-count').first().innerText(), /^~[\d,]+$/);
  await shot('5-patterns');
  await page.getByRole('tab', { name: 'Results Table' }).click();
});

test('Live Tail polls at the chosen interval', async () => {
  await open('source=logs&t=live');
  await page.getByLabel('Live tail refresh interval').selectOption('1');
  let searches = 0;
  const count = (r: { url: () => string }) => { if (r.url().includes('/api/search')) searches++; };
  page.on('request', count);
  await page.waitForTimeout(3500);
  page.off('request', count);
  assert.ok(searches >= 2, `${searches} searches in 3.5 s at 1 s`);
});

test('errors and unknown fields are explained', async () => {
  await open('source=logs&t=7d');
  await run('"unterminated');
  assert.match(await page.getByRole('alert').innerText(), /unterminated phrase/);
  await run('levl:ERROR');
  const warning = page.getByRole('status').filter({ hasText: 'levl' });
  await warning.getByRole('button', { name: 'level' }).click();
  await page.waitForURL(/where=level%3AERROR/);
  await settled();
  assert.ok(await total() > 0);
});

test('planned pages say so; going back to Search keeps the query', async () => {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Dashboards' }).click();
  assert.match(await page.locator('.planned').innerText(), /Not built yet/);
  await nav.getByRole('button', { name: 'Search', exact: true }).click();
  await settled();
  assert.equal(await where().inputValue(), 'level:ERROR');
});

test('a phone-width screen has no horizontal scroll', async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  const p = await phone.newPage();
  await p.goto(`${base}/search?source=logs&t=7d`);
  await p.locator('.count', { hasText: /results$/ }).waitFor();
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
  const input = (await p.getByLabel('Search query').boundingBox())!;
  assert.ok(input.width > 200, `query box ${input.width}px`);
  if (shots) await p.screenshot({ path: `${shots}/6-phone.png` });
  await phone.close();
});

test('team settings: an API key works as a bearer token; users; logout', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Team settings' }).click();
  await page.getByLabel('New key name').fill('ci');
  await page.getByRole('button', { name: 'Create key' }).click();
  const key = await page.getByTestId('new-key').innerText();
  await page.locator('table.list').first().getByRole('cell', { name: 'ci', exact: true }).waitFor();
  assert.equal((await fetch(`${base}/api/fields?source=logs`)).status, 401);
  assert.equal((await fetch(`${base}/api/fields?source=logs`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
  await page.getByLabel('New user email').fill('mia@example.com');
  await page.getByLabel('New user password').fill('memberpass');
  await page.getByRole('button', { name: 'Add user' }).click();
  await page.getByRole('cell', { name: 'mia@example.com', exact: true }).waitFor();
  await shot('7-settings');
  await page.locator('.nav-item.user').click();
  await page.getByRole('menuitem', { name: 'Logout' }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  assert.equal(await page.evaluate(() => fetch('/api/fields?source=logs').then((r) => r.status)), 401);
});
