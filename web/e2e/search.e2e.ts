// Browser test of the web UI against a live Doris loaded by bench/otelgen.py and a fresh
// PostgreSQL metadata database. Starts the API service in-process (serving web/dist), drives
// headless Chromium from first-run setup through search, the side panel, settings and logout.
//
//   npm run build && DORIS_PORT=9930 DORIS_DB=otel_bench SHOTS=/tmp/shots npm run e2e

import { IngestKeys } from '../../server/src/sessions/http.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { ContentStore } from '../../server/src/content/store.ts';
import { createServer } from 'node:http';
import { AuthStore } from '../../server/src/auth/store.ts';
import { AlertRunner } from '../../server/src/content/alerts.ts';
import { Doris, configFromEnv } from '../../server/src/db.ts';
import { createApp, sourcesFor } from '../../server/src/server.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';

const shots = process.env.SHOTS;
let base = '';
let browser: Browser;
let page: Page;
let stop: () => Promise<void> = async () => {};
let runner: AlertRunner;
let doris: Doris;
let hookUrl = '';
const received: { text: string }[] = [];
const DB = process.env.DORIS_DB ?? 'otel_bench';

before(async () => {
  doris = new Doris(configFromEnv());
  const meta = await freshMetaDb();
  const hook = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { received.push(JSON.parse(b)); res.end('ok'); });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  const webDir = new URL('../dist', import.meta.url).pathname;
  const auth = { store: new AuthStore(meta.pool), secureCookie: false };
  const content = new ContentStore(meta.pool);
  const server = createApp({ doris, db: DB, auth, content, webDir, ingestKeys: new IngestKeys(meta.pool) });
  // The clock sits at the end of the loaded data, so alert windows contain events.
  const t = String(((await doris.query(`SELECT max(timestamp) AS t FROM ${DB}.otel_logs`)) as { t: string }[])[0]!.t);
  const end = Date.parse(`${String(t).replace(' ', 'T')}Z`) + 1000;
  runner = new AlertRunner({ store: content, doris, sources: sourcesFor(DB), now: () => end });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  if (shots) mkdirSync(shots, { recursive: true });
  stop = async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => hook.close(() => r()));
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
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${item}( Beta)?$`) }).count(), 1, item);
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
  assert.match(await page.getByRole('alert').innerText(), /one expression only/);
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

test('leaving Search and coming back keeps the query', async () => {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Client sessions' }).click();
  await page.getByRole('heading', { name: 'Client sessions' }).waitFor();
  await nav.getByRole('button', { name: 'Search', exact: true }).click();
  await settled();
  assert.equal(await where().inputValue(), 'level:ERROR');
});

test('save a search, star it, reopen it from the navigation, update it', async () => {
  await open(`source=logs&t=7d&where=${encodeURIComponent('level:error')}`);
  await page.getByLabel('Filters').getByRole('region', { name: 'service_name' }).getByRole('checkbox', { name: 'service_name = payment' }).check();
  await settled();
  const payment = await total();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save search' });
  await dialog.getByLabel('Name').fill('Payment errors');
  await dialog.getByLabel('Tags').fill('payments, oncall');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/saved=\d+/);
  assert.equal(await page.getByLabel('Saved search name').inputValue(), 'Payment errors');
  assert.equal(await page.getByRole('button', { name: 'Update' }).isDisabled(), true, 'nothing to update yet');
  await page.getByRole('button', { name: 'Star saved search' }).click();
  const favs = page.getByRole('list', { name: 'Favorite saved searches' });
  await favs.getByRole('button', { name: 'Payment errors' }).waitFor();
  await run('level:error OR level:warn');
  assert.equal(await page.getByRole('button', { name: 'Update' }).isDisabled(), false);
  await page.getByRole('button', { name: 'Update' }).click();
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.saved-bar .btn.small')?.disabled === true);
  await page.goto(`${base}/search/list`);
  const row = page.locator('table.list tbody tr', { hasText: 'Payment errors' });
  await row.waitFor();
  assert.match(await row.innerText(), /level:error OR level:warn[\s\S]*payments[\s\S]*oncall/);
  await page.getByRole('list', { name: 'Favorite saved searches' }).getByRole('button', { name: 'Payment errors' }).click();
  await settled();
  assert.equal(await where().inputValue(), 'level:error OR level:warn');
  // A saved search keeps the query, not the time range (as in ClickStack): pick one.
  await page.getByRole('button', { name: 'Time Range' }).click();
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await settled();
  assert.ok(await total() > payment, 'errors and warnings are more than errors');
  await shot('8-saved-search');
});

test('admin adds a webhook; an alert on the saved search fires and is listed', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Team settings' }).click();
  await page.getByLabel('Webhook name').fill('#oncall');
  await page.getByLabel('Webhook URL').fill(hookUrl);
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.getByRole('cell', { name: '#oncall', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send test' }).click();
  await page.getByRole('status').filter({ hasText: 'Test message sent' }).waitFor();
  assert.equal(received.at(-1)!.text, '[TEST] Nereus webhook test');

  await page.getByRole('list', { name: 'Favorite saved searches' }).getByRole('button', { name: 'Payment errors' }).click();
  await page.locator('.saved-bar').getByRole('button', { name: /Alerts/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Alerts for "Payment errors"' });
  await dialog.getByLabel('Threshold', { exact: true }).fill('3');
  await dialog.getByLabel('Interval').selectOption('3600');
  await dialog.getByRole('button', { name: 'Create alert' }).click();
  await dialog.getByText('count > 3 per 1h').waitFor();
  await page.keyboard.press('Escape');

  assert.equal(await runner.tick(), 1);
  assert.match(received.at(-1)!.text, /^\[ALERT\] "Payment errors": \d+ matches in the last 1h \(alert when above 3\)$/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Alerts', exact: true }).click();
  const row = page.locator('table.list tbody tr', { hasText: 'Payment errors' });
  await row.waitFor();
  assert.match(await row.innerText(), /ALERT[\s\S]*count > 3 per 1h[\s\S]*#oncall/);
  await row.click();
  await page.locator('tr.expanded').getByText('yes').waitFor();
  await shot('9-alerts');
  // The nav marks a favorite whose alert is firing.
  await page.goto(`${base}/alerts`);
  await page.getByRole('list', { name: 'Favorite saved searches' }).locator('.lvl-error').waitFor();
});

test('Chart explorer: p99 by service, a number, then save to a new dashboard', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Chart explorer' }).click();
  await page.getByLabel('Chart source').selectOption('traces');
  await page.getByLabel('Aggregate 1').selectOption('p99');
  await page.getByLabel('Field 1').fill('duration');
  await page.getByLabel('Group by').fill('service');
  const range = page.getByRole('button', { name: 'Time Range' });
  await range.click();
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  const legend = page.locator('.chart-legend');
  await legend.getByText('checkout').waitFor();
  assert.ok((await legend.locator('span').count()) >= 5, 'a line per service');
  await shot('10-chart');
  await page.getByRole('tab', { name: 'Number' }).click();
  await page.getByLabel('Group by').fill('');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.locator('.chart-number strong').waitFor();
  assert.match(await page.locator('.chart-number').innerText(), /[\d.,]+k?\s*p99\(duration\)/);
  await page.getByRole('button', { name: 'Save to dashboard' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save to dashboard' });
  await dialog.getByLabel('Tile title').fill('p99 latency');
  await dialog.getByLabel('New dashboard name').fill('Checkout health');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/\/dashboards\/\d+$/);
  await page.getByRole('region', { name: 'p99 latency' }).locator('.chart-number strong').waitFor();
});

test('dashboards: add, edit, duplicate and delete tiles; changes persist', async () => {
  await page.getByRole('button', { name: 'Time Range' }).click();
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await page.getByRole('button', { name: 'New Tile' }).click();
  const editor = page.getByRole('dialog', { name: 'New tile' });
  await editor.getByLabel('Title').fill('Logs by level');
  await editor.getByRole('tab', { name: 'Table' }).click();
  await editor.getByLabel('Group by').fill('level');
  await editor.getByRole('button', { name: 'Run' }).click();
  await editor.locator('.chart-table').getByText('ERROR').waitFor();
  await editor.getByRole('button', { name: 'Add tile' }).click();
  const tile = page.getByRole('region', { name: 'Logs by level' });
  await tile.getByText('WARN').waitFor();
  await page.getByText('Saved', { exact: true }).waitFor();
  await tile.getByRole('button', { name: 'Tile menu Logs by level' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.getByRole('region', { name: 'Logs by level (copy)' }).waitFor();
  await page.getByRole('region', { name: 'Logs by level (copy)' }).getByRole('button', { name: /Tile menu/ }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('dialog', { name: 'Edit tile' }).getByLabel('Title').fill('Logs by service');
  await page.getByRole('dialog', { name: 'Edit tile' }).getByLabel('Group by').fill('service');
  await page.getByRole('dialog', { name: 'Edit tile' }).getByRole('button', { name: 'Run' }).click();
  await page.getByRole('dialog', { name: 'Edit tile' }).getByRole('button', { name: 'Save tile' }).click();
  await page.getByRole('region', { name: 'Logs by service' }).getByText('frontend').waitFor();
  await page.getByText('Saved', { exact: true }).waitFor();
  await shot('11-dashboard');
  await page.reload();
  await page.getByRole('region', { name: 'Logs by service' }).waitFor();
  assert.deepEqual(await page.locator('.tile .tile-head strong').allInnerTexts(), ['p99 latency', 'Logs by level', 'Logs by service']);
  await page.getByRole('region', { name: 'Logs by level' }).getByRole('button', { name: /Tile menu/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('region', { name: 'Logs by service' }).waitFor();
  assert.deepEqual(await page.locator('.tile .tile-head strong').allInnerTexts(), ['p99 latency', 'Logs by service']);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Dashboards', exact: true }).click();
  assert.match(await page.locator('table.list tbody').innerText(), /Checkout health\s+2/);
});

test('tile alerts: create from the tile menu; the bell and the Alerts page show it firing', async () => {
  const tile = { title: 'Latency by service', w: 6, chart: { source: 'traces', display: 'line', series: [{ agg: 'p99', field: 'duration' }], groupBy: 'service' } };
  const dash = await page.evaluate(async (t) => (await fetch('/api/dashboards', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Alerting', tiles: [t] }),
  })).json(), tile);
  await page.goto(`${base}/dashboards/${dash.id}`);
  await page.getByRole('button', { name: 'Tile menu Latency by service' }).click();
  await page.getByRole('menuitem', { name: 'Alerts…' }).click();
  const dialog = page.getByRole('dialog');
  assert.match(await dialog.innerText(), /Alert when p99\(duration\) of any service is/);
  await dialog.getByLabel('Threshold', { exact: true }).fill('0');
  await dialog.getByLabel('Interval').selectOption({ label: '1h' });
  await dialog.getByRole('button', { name: 'Create alert' }).click();
  await dialog.locator('tbody tr').first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Alerts for Latency by service: OK' }).waitFor();
  // Only this alert is due; the runner's clock is at the end of the data.
  while (await runner.tick() > 0) { /* check everything due */ }
  await page.reload();
  await page.getByRole('button', { name: 'Alerts for Latency by service: ALERT' }).waitFor({ timeout: 20_000 });
  await shot('14-tile-alert');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Alerts', exact: true }).click();
  const row = page.locator('table.list tbody tr', { hasText: 'Alerting / Latency by service' });
  await row.waitFor();
  const text = await row.innerText();
  assert.match(text, /p99\(duration\) > 0 per 1h/);
  assert.match(text, /\((frontend|checkout|cart|payment|shipping|product-catalog)\)/, text);
  assert.ok(received.some((m) => /^\[ALERT\] "Alerting \/ Latency by service": p99\(duration\) = /.test(m.text)), 'the webhook got the message');
});

test('service map: calls between services; a service opens its traces', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Service map/ }).click();
  await page.getByRole('button', { name: 'Time Range' }).click();
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await page.locator('[data-edge="frontend->checkout"]').waitFor({ timeout: 60_000 });
  assert.ok(await page.locator('[data-edge="checkout->payment"]').count());
  assert.equal(await page.locator('[data-edge$="->frontend"]').count(), 0, 'nothing calls the frontend');
  const stats = (await page.locator('[data-service="frontend"] .map-stats').textContent())!;
  assert.match(stats, /req · [\d.]+% err · p99 /);
  await shot('11-service-map');
  await page.getByRole('button', { name: 'checkout: open its traces' }).click();
  await settled();
  const p = new URLSearchParams(new URL(page.url()).search);
  assert.equal(p.get('source'), 'traces');
  assert.deepEqual(JSON.parse(p.get('filters')!), [{ field: 'service_name', values: ['checkout'] }]);
});

test('event deltas: select slow spans on the heatmap and compare their attributes', async () => {
  await open('source=traces&t=7d');
  await page.getByRole('tab', { name: 'Event Deltas' }).click();
  const heat = page.getByRole('img', { name: 'Duration heatmap' });
  await heat.locator('rect').first().waitFor({ timeout: 60_000 });
  await page.getByText('Select an area on the chart above').waitFor();
  const box = (await heat.boundingBox())!;
  // Upper third of the chart, the whole time span: the slowest spans.
  await page.mouse.move(box.x + 70, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 50, { steps: 4 });
  await page.mouse.move(box.x + box.width - 2, box.y + 70, { steps: 4 });
  await page.mouse.up();
  await page.locator('.delta-card').first().waitFor({ timeout: 60_000 });
  assert.ok(await page.locator('.delta-card').count() > 0);
  await shot('12-event-deltas');
  const card = page.locator('.delta-card').first();
  const field = await card.locator('strong').innerText();
  const value = await card.locator('.delta-row .dv').first().innerText();
  await card.locator('.delta-row').first().hover();
  await card.locator('.delta-row').first().getByRole('button', { name: 'Filter', exact: true }).click();
  await page.waitForFunction(([f, v]) => (new URLSearchParams(location.search).get('filters') ?? '').includes(JSON.stringify(f)) && (new URLSearchParams(location.search).get('filters') ?? '').includes(JSON.stringify(v === '(empty)' ? '' : v)), [field, value]);
});

test('search extras: group by, denoise, CSV, column resize, query history, natural-language time', async () => {
  await open('source=traces&t=7d');
  await page.getByLabel('Group by').fill('service_name');
  await page.getByLabel('Group by').press('Enter');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('groupBy') === 'service_name');
  await settled();
  const legend = await page.locator('.histogram .legend').innerText();
  assert.match(legend, /frontend/);
  assert.match(legend, /checkout/);

  await open('source=logs&t=7d');
  const before = await rows().count();
  await page.getByRole('button', { name: 'Denoise' }).click();
  await page.locator('.denoise-note', { hasText: /hidden/ }).waitFor({ timeout: 60_000 });
  const note = await page.locator('.denoise-note').innerText();
  const hidden = Number(/, ([\d,]+) of/.exec(note)![1]!.replace(/,/g, ''));
  assert.equal(await rows().count(), before - hidden, note);
  await page.getByRole('button', { name: 'Denoise' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const file = await (await download).path();
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(file, 'utf8').trimEnd().split('\r\n');
  assert.equal(lines[0], 'timestamp,service_name,severity_text,body');
  assert.equal(lines.length, (await rows().count()) + 1);

  const th = page.locator('table.results thead th').nth(1);
  const w0 = (await th.boundingBox())!.width;
  const handle = (await page.getByRole('separator', { name: 'Resize column service_name' }).boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 103, handle.y + 5, { steps: 5 });
  await page.mouse.up();
  const w1 = (await th.boundingBox())!.width;
  assert.ok(Math.abs(w1 - w0 - 100) < 4, `width ${w0} -> ${w1}`);

  await run('level:warn');
  await run('');
  await where().click();
  const recent = page.locator('.suggestions li', { has: page.getByText('level:warn', { exact: true }) });
  await recent.waitFor();
  await recent.click();
  assert.equal(await where().inputValue(), 'level:warn');
  await where().press('Escape');

  await page.getByRole('button', { name: 'Time Range' }).click();
  await page.locator('#tp-phrase').fill('last 2 hours');
  await page.locator('#tp-phrase').press('Enter');
  await page.waitForFunction(() => {
    const p = new URLSearchParams(location.search);
    return Number(p.get('to')) - Number(p.get('from')) === 2 * 3600_000;
  });
  await shot('13-search-extras');
});

test('client sessions: the SDK on another site records a session that replays, masked', async () => {
  // An admin creates an ingestion key in Team settings.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Team settings' }).click();
  await page.getByLabel('Ingestion key name').fill('acme shop');
  await page.getByRole('button', { name: 'Create ingestion key' }).click();
  const key = await page.getByTestId('new-ingest-key').innerText();
  assert.match(key, /^nereus_ingest_/);

  // The shop runs on its own origin and loads the SDK from Nereus.
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../sdk-example/shop.html', import.meta.url), 'utf8');
  // The shop's backend is "instrumented": it continues the browser's traceparent in a server span.
  let backendTrace = '';
  const shopServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/api/checkout')) {
      const [, traceId, parent] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(String(req.headers.traceparent ?? '')) ?? [];
      if (!traceId) return res.writeHead(400).end('no traceparent');
      backendTrace = traceId;
      const t = new Date().toISOString().replace('T', ' ').replace('Z', '');
      return void doris.query(`INSERT INTO ${DB}.otel_traces (service_name, timestamp, trace_id, span_id, parent_span_id, span_name, span_kind, duration, status_code, is_root) ` +
        `VALUES ('acme-api', '${t}', '${traceId}', 'a1b2c3d4e5f60718', '${parent}', 'POST /api/checkout', 'SPAN_KIND_SERVER', 41000, 'STATUS_CODE_ERROR', 0)`)
        .then(() => res.writeHead(503).end('down'), () => res.writeHead(500).end('insert failed'));
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => shopServer.listen(0, '127.0.0.1', r));
  const shop = `http://127.0.0.1:${(shopServer.address() as AddressInfo).port}`;
  const visitor = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const sp = await visitor.newPage();
  await sp.goto(`${shop}/?ds=${encodeURIComponent(base)}&key=${encodeURIComponent(key)}`);
  await sp.waitForFunction(() => (window as any).dsReady === true);
  await sp.click('#add-teapot');
  // Pauses like a person's, so the replay has a few seconds to seek in.
  await sp.waitForTimeout(800);
  await sp.click('#add-mug');
  await sp.waitForTimeout(800);
  await sp.click('#nav-cart');
  await sp.click('#card');
  await sp.fill('#card', '4111 1111 1111 1111');
  await sp.waitForTimeout(1200);
  await sp.click('#checkout');
  await sp.locator('#message', { hasText: 'Payment failed (503)' }).waitFor();
  await sp.waitForTimeout(300);
  const sid = await sp.evaluate(async () => { await (window as any).NereusRUM.flush(); return (window as any).NereusRUM.sessionId(); });
  await visitor.close();
  await new Promise<void>((r) => shopServer.close(() => r()));

  // Inputs are masked: the card number is nowhere in what was stored.
  const [{ n, leaks }] = await doris.query(`SELECT count(*) AS n, sum(if(payload LIKE '%4111%' OR message LIKE '%4111%', 1, 0)) AS leaks FROM ${DB}.otel_sessions WHERE session_id = '${sid}'`) as any[];
  assert.ok(Number(n) > 5, `${n} rows`);
  assert.equal(Number(leaks), 0);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Client sessions' }).click();
  const row = page.locator(`tr[data-session="${sid}"]`);
  await row.waitFor({ timeout: 30_000 });
  const cells = await row.locator('td').allInnerTexts();
  assert.match(cells[0]!, /ada@example\.com/);
  assert.match(cells[0]!, /acme-shop/);
  assert.ok(Number(cells[5]) >= 4, `clicks ${cells[5]}`);
  assert.ok(Number(cells[6]) >= 2, `errors ${cells[6]}: the failed request and the thrown error`);
  await page.getByLabel('Session filter').fill('email:nobody@example.com');
  await page.getByLabel('Session filter').press('Enter');
  await page.locator('.empty', { hasText: 'No sessions' }).waitFor();
  await page.getByLabel('Session filter').fill('"payment service unavailable"');
  await page.getByLabel('Session filter').press('Enter');
  await row.click();

  // The replay renders the recorded page in a sandbox that runs no scripts.
  const frame = page.locator('[data-testid="replay"] iframe');
  await frame.waitFor({ timeout: 30_000 });
  const sandbox = (await frame.getAttribute('sandbox')) ?? '';
  assert.ok(sandbox !== null && !sandbox.includes('allow-scripts'), `sandbox="${sandbox}"`);
  await page.frameLocator('[data-testid="replay"] iframe').getByText('Teapot').waitFor();
  const list = page.getByRole('complementary', { name: 'Session events' });
  const text = await list.innerText();
  assert.match(text, /navigation/i);
  assert.match(text, /button#add-teapot "Add to cart"/);
  assert.match(text, /POST http:\/\/127\.0\.0\.1:\d+\/api\/checkout 503/);
  assert.match(text, /Checkout failed: payment service unavailable/);
  assert.match(text, /input#card/);
  assert.doesNotMatch(text, /4111/);
  const urls = (await doris.query(`SELECT url FROM ${DB}.otel_sessions WHERE session_id = '${sid}' AND event_type = 'navigation' ORDER BY timestamp`) as any[]).map((r) => r.url);
  assert.deepEqual(urls.map((u: string) => new URL(u).pathname), ['/', '/cart'], 'page views, without the example\'s parameters');
  await list.getByRole('tab', { name: /^Errors/ }).click();
  assert.equal(await list.locator('li').count(), 2);
  await list.locator('li', { hasText: 'Checkout failed' }).getByRole('button').click();
  assert.notEqual(await page.getByLabel('Replay time').innerText(), '0:00 / 0:00');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('button', { name: 'Pause' }).waitFor();
  await shot('15-session-replay');
  await page.getByRole('button', { name: 'Pause' }).click();

  // The failed request carried a traceparent: its backend trace opens from the timeline...
  assert.match(backendTrace, /^[0-9a-f]{32}$/);
  await list.getByRole('tab', { name: /^Network/ }).click();
  const req = list.locator('li', { hasText: '/api/checkout' });
  await req.getByRole('button').first().click();
  await req.getByRole('button', { name: 'Open trace' }).click();
  await page.waitForFunction((t) => new URLSearchParams(location.search).get('where') === `trace_id:${t}`, backendTrace);
  const panel = page.locator('.wf-row', { hasText: 'POST /api/checkout' });
  await panel.waitFor({ timeout: 30_000 });
  assert.match(await panel.innerText(), /acme-api/);
  // ...and the trace leads back to the session, at the request.
  await page.getByRole('note').getByRole('button', { name: 'Open session replay' }).waitFor();
  await shot('16-trace-from-session');
  await page.getByRole('note').getByRole('button', { name: 'Open session replay' }).click();
  await page.waitForFunction((id) => new URLSearchParams(location.search).get('session') === id, sid);
  await page.locator('[data-testid="replay"] iframe').waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Replay time"]')?.textContent?.startsWith('0:00') === false);
  await shot('17-back-to-session');
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
