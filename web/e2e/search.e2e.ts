// Browser test of the search page against a live Doris loaded by bench/otelgen.py.
// Starts the API service in-process (serving web/dist), drives headless Chromium.
//
//   npm run build && DORIS_PORT=9730 DORIS_DB=otel_bench SHOTS=/tmp/shots npm run e2e

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { Doris, configFromEnv } from '../../server/src/db.ts';
import { createApp } from '../../server/src/server.ts';

const shots = process.env.SHOTS;
let base = '';
let browser: Browser;
let page: Page;
let stop: () => Promise<void> = async () => {};

before(async () => {
  const doris = new Doris(configFromEnv());
  const webDir = new URL('../dist', import.meta.url).pathname;
  const server = createApp({ doris, db: process.env.DORIS_DB ?? 'otel_bench', webDir });
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
  };
});
after(() => stop());

const shot = (name: string) => (shots ? page.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve());
const rows = () => page.locator('table.results tbody tr');
const query = () => page.getByLabel('Search query');
const settled = () => page.locator('.status', { hasText: /^Showing/ }).waitFor();

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
