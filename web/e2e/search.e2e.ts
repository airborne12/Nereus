// Browser test of the web UI against a live Doris loaded by bench/otelgen.py and a fresh
// PostgreSQL metadata database. Starts the API service in-process (serving web/dist), drives
// headless Chromium from first-run setup through search, settings and sign-out.
//
//   npm run build && DORIS_PORT=9730 DORIS_DB=otel_bench SHOTS=/tmp/shots npm run e2e

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { Doris, configFromEnv } from '../../server/src/db.ts';
import { AuthStore } from '../../server/src/auth/store.ts';
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
const query = () => page.getByLabel('Search query');
const settled = () => page.locator('.status', { hasText: /^Showing/ }).waitFor();

test('first run asks for an admin account, then opens search', async () => {
  await page.goto(`${base}/?source=logs&t=24h`);
  await page.getByRole('button', { name: 'Create admin account' }).waitFor();
  await shot('0-setup');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Name').fill('Ada Admin');
  await page.getByLabel('Password').fill('adminpass1');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await page.getByLabel('Search query').waitFor();
  assert.match(await page.locator('.user-menu').innerText(), /Ada Admin/);
});

test('the page loads newest rows and a histogram', async () => {
  await page.goto(`${base}/?source=logs&t=24h`);
  await settled();
  assert.equal(await rows().count(), 200);
  assert.match(await page.locator('.histogram-head').innerText(), /[\d,]+ matches/);
  assert.ok(await page.locator('.histogram rect').count() > 10);
  await shot('1-logs');
});

test('completion fills a field and a value, Enter searches', async () => {
  await query().click();
  await query().fill('lev');
  await page.getByRole('option', { name: /^level/ }).waitFor();
  await query().press('Tab');
  assert.equal(await query().inputValue(), 'level:');
  await page.getByRole('option', { name: /^ERROR/ }).waitFor();
  await shot('2-completion');
  await page.getByRole('option', { name: /^ERROR/ }).click();
  assert.equal(await query().inputValue(), 'level:"ERROR" ');
  await query().press('Enter');
  await page.waitForURL(/q=level/);
  await settled();
  const levels = await page.locator('table.results tbody td.c-lvl').allInnerTexts();
  assert.ok(levels.length > 0);
  assert.ok(levels.every((l) => l === 'ERROR'), `levels: ${[...new Set(levels)]}`);
});

test('a value in the detail panel becomes a filter', async () => {
  await rows().first().click();
  const panel = page.getByLabel('Event details');
  await panel.waitFor();
  const svc = await rows().first().locator('td.c-svc').innerText();
  await shot('3-detail');
  await panel.getByRole('button', { name: 'Filter service_name' }).click();
  await page.waitForURL(/service_name/);
  await settled();
  assert.equal(await query().inputValue(), `level:"ERROR" service_name:"${svc}"`);
  const services = await page.locator('table.results tbody td.c-svc').allInnerTexts();
  assert.ok(services.every((s) => s === svc));
});

test('View trace shows the waterfall with the log line span', async () => {
  await rows().first().click();
  await page.getByRole('button', { name: 'View trace' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.wf-row').first().waitFor();
  const n = await dialog.locator('.wf-row').count();
  assert.ok(n >= 2, `spans: ${n}`);
  assert.match(await dialog.innerText(), new RegExp(`${n} spans`));
  assert.ok(await dialog.locator('.wf-bar.err').count() >= 1, 'an ERROR log comes from a failed trace');
  assert.match(page.url(), /trace=[0-9a-f]{32}/);
  await shot('4-trace');
  await page.getByRole('button', { name: 'Close trace' }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
});

test('dragging across the histogram zooms the time range', async () => {
  const box = (await page.locator('.histogram svg').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForURL(/from=\d+&to=\d+/);
  await settled();
  const u = new URL(page.url());
  const span = Number(u.searchParams.get('to')) - Number(u.searchParams.get('from'));
  assert.ok(span > 0.2 * 86400_000 && span < 0.4 * 86400_000, `zoomed span ${span} ms`);
  assert.equal(await page.getByLabel('Time range').inputValue(), 'custom');
});

test('traces: comparisons filter durations', async () => {
  await page.goto(`${base}/?source=traces&t=24h&q=${encodeURIComponent('service:frontend duration:>50000')}`);
  await settled();
  const durations = await page.locator('table.results tbody td.c-dur').allInnerTexts();
  assert.ok(durations.length > 0);
  for (const d of durations) {
    const ms = d.endsWith(' s') ? Number(d.slice(0, -2)) * 1000 : Number(d.replace(' ms', ''));
    assert.ok(ms > 50, d);
  }
  await shot('5-traces');
});

test('a syntax error is shown, not swallowed', async () => {
  await query().fill('"unterminated');
  await query().press('Enter');
  const alert = page.getByRole('alert');
  await alert.waitFor();
  assert.match(await alert.innerText(), /unterminated phrase/);
  await shot('6-error');
});

test('Back restores the previous search', async () => {
  await page.goBack();
  await settled();
  assert.equal(await query().inputValue(), 'service:frontend duration:>50000');
  assert.equal(await page.getByRole('alert').count(), 0);
});

test('lower-case levels and a misspelled field', async () => {
  await page.goto(`${base}/?source=logs&t=24h`);
  await settled();
  await query().fill('level:error');
  await query().press('Escape');
  await query().press('Enter');
  await page.waitForURL(/q=level/);
  await settled();
  const levels = [...new Set(await page.locator('td.c-lvl').allInnerTexts())];
  assert.deepEqual(levels, ['ERROR']);
  await query().fill('levl:ERROR');
  await query().press('Escape');
  await query().press('Enter');
  const warning = page.getByRole('status').filter({ hasText: 'levl' });
  await warning.waitFor();
  assert.match(await warning.innerText(), /No data has a field levl.*Did you mean level\?/s);
  await shot('6b-warning');
  await warning.getByRole('button', { name: 'level' }).click();
  await page.waitForURL(/q=level%3AERROR/);
  await settled();
  assert.equal(await query().inputValue(), 'level:ERROR');
  assert.ok(await rows().count() > 0);
});

test('traces: bare words, short status values, unit durations, a pasted trace id', async () => {
  await page.goto(`${base}/?source=traces&t=24h&q=${encodeURIComponent('checkout status:error duration:>1ms')}`);
  await settled();
  assert.ok(await rows().count() > 0, 'checkout status:error duration:>1ms finds spans');
  const statuses = [...new Set(await page.locator('table.results tbody td.c-lvl').allInnerTexts())];
  assert.deepEqual(statuses, ['error']);
  await rows().first().click();
  const tid = await page.locator('.kv', { hasText: 'trace_id' }).locator('dd').first().innerText();
  await page.getByRole('button', { name: 'Close details' }).click();
  await query().fill(tid.toUpperCase());
  await query().press('Escape');
  await query().press('Enter');
  await page.waitForURL(new RegExp(`q=${tid.toUpperCase()}`));
  await settled();
  const n = await rows().count();
  assert.ok(n >= 2, `spans of the pasted trace: ${n}`);
});

test('a phone-width screen has no horizontal scroll and keeps the body column', async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  const p = await phone.newPage();
  await p.goto(`${base}/?source=logs&t=24h`);
  await p.locator('.status', { hasText: /^Showing/ }).waitFor();
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
  const body = (await p.locator('table.results tbody td.c-body').first().boundingBox())!;
  assert.ok(body.width > 150, `body column ${body.width}px wide`);
  const input = (await p.getByLabel('Search query').boundingBox())!;
  assert.ok(input.width > 300, `query box ${input.width}px wide`);
  await p.locator('table.results tbody tr').first().click();
  const panel = (await p.getByLabel('Event details').boundingBox())!;
  assert.equal(Math.round(panel.width), 390);
  if (shots) await p.screenshot({ path: `${shots}/9-phone-detail.png` });
  await p.getByRole('button', { name: 'Close details' }).click();
  if (shots) await p.screenshot({ path: `${shots}/9-phone.png` });
  await phone.close();
});

test('settings: an API key is shown once and works as a bearer token', async () => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'API keys' }).waitFor();
  await page.getByLabel('New key name').fill('ci');
  await page.getByRole('button', { name: 'Create key' }).click();
  const key = await page.getByTestId('new-key').innerText();
  assert.match(key, /^dsk_[\w-]{43}$/);
  // The list reloads after the key is shown; wait for its row.
  await page.locator('table.list').first().getByRole('cell', { name: 'ci', exact: true }).waitFor();
  assert.match(await page.locator('table.list').first().innerText(), /ci\s+dsk_/);
  await shot('7-settings');
  const anon = await fetch(`${base}/api/fields?source=logs`);
  assert.equal(anon.status, 401);
  const withKey = await fetch(`${base}/api/fields?source=logs`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(withKey.status, 200);
  await page.getByRole('button', { name: 'Revoke ci' }).click();
  await page.locator('table.list tr.revoked').first().waitFor();
  assert.equal((await fetch(`${base}/api/fields?source=logs`, { headers: { authorization: `Bearer ${key}` } })).status, 401);
});

test('an admin adds a member, who can search but not manage users', async () => {
  await page.getByLabel('New user email').fill('mia@example.com');
  await page.getByLabel('New user name').fill('Mia');
  await page.getByLabel('New user password').fill('memberpass');
  await page.getByRole('button', { name: 'Add user' }).click();
  await page.getByRole('cell', { name: 'mia@example.com', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor();

  await page.getByLabel('Email').fill('mia@example.com');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  assert.match(await page.getByRole('alert').innerText(), /wrong email or password/);
  await page.getByLabel('Password').fill('memberpass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'API keys' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Users' }).count(), 0);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Search query').waitFor();
  await settled();
  assert.ok(await rows().count() > 0);
});

test('signing out returns to the login page and closes the API', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  const status = await page.evaluate(() => fetch('/api/fields?source=logs').then((r) => r.status));
  assert.equal(status, 401);
  await shot('8-login');
});
