// Real HTTP browser checks, including an origin without secure-context browser APIs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, test } from 'node:test';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { Doris, configFromEnv } from '../../server/src/db.ts';
import { AuthStore } from '../../server/src/auth/store.ts';
import { ContentStore } from '../../server/src/content/store.ts';
import { IngestKeys } from '../../server/src/sessions/http.ts';
import { createApp } from '../../server/src/server.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';

const db = process.env.DORIS_DB ?? 'otel_bench';
const service = `repair-${randomUUID().replaceAll('-', '')}`;
let doris: Doris, browser: Browser, context: BrowserContext, page: Page, secure: Page;
let base = '', local = '', sessionId = '';
let stop = async () => {};
let dashboardId = 0;

before(async () => {
  doris = new Doris(configFromEnv());
  const meta = await freshMetaDb();
  const store = new AuthStore(meta.pool);
  const admin = await store.setup('repairs@example.com', 'Repair tests', 'repairpass1');
  const ingest = new IngestKeys(meta.pool);
  const ingestKey = await ingest.create(admin.id, 'No replay');
  const server = createApp({ doris, db, auth: { store, secureCookie: false }, content: new ContentStore(meta.pool),
    ingestKeys: ingest, webDir: new URL('../dist', import.meta.url).pathname });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as AddressInfo).port;
  local = `http://127.0.0.1:${port}`;
  const host = process.env.BROWSER_HTTP_HOST ?? Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address;
  if (!host) throw new Error('HTTP browser tests require a non-loopback IPv4 address');
  base = `http://${host}:${port}`;
  browser = await chromium.launch();
  stop = async () => {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await doris.query(`DELETE FROM ${db}.otel_logs WHERE service_name='${service}'`);
    if (sessionId) await doris.query(`DELETE FROM ${db}.otel_sessions WHERE session_id='${sessionId}'`);
    await doris.close();
    await meta.drop();
  };
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: local });
  page = await context.newPage();
  secure = await context.newPage();
  await secure.goto(local);
  await page.goto(base);
  await page.getByLabel('Email', { exact: true }).fill('repairs@example.com');
  await page.getByLabel('Password', { exact: true }).fill('repairpass1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Search query').waitFor();
  sessionId = `s_${randomUUID().replaceAll('-', '')}`;
  const at = Date.now() - 5000;
  const response = await fetch(`${local}/api/ingest/sessions`, { method: 'POST',
    headers: { authorization: `Bearer ${ingestKey.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, service, events: [
      { t: at, type: 'navigation', message: 'No replay page', url: 'https://example.com/cart' },
      { t: at + 1000, type: 'error', message: 'No replay error', attributes: { reason: 'test' } },
      { t: at + 2000, type: 'network', message: 'No replay request', attributes: { trace_id: 'a'.repeat(32), status: 503 } },
    ] }) });
  assert.equal(response.status, 200, await response.text());
  const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const values = Array.from({ length: 125 }, (_, i) => `('${service}','${timestamp}','instance-${String(i).padStart(3, '0')}','INFO','repair log ${i}')`);
  await doris.query(`INSERT INTO ${db}.otel_logs(service_name,timestamp,service_instance_id,severity_text,body) VALUES ${values.join(',')}`);
});
after(() => stop());

async function api(path: string) {
  return page.evaluate(async (path) => { const r = await fetch(path); return await r.json(); }, path);
}
async function search(query = '') {
  await page.goto(`${base}/search?source=logs&t=7d${query ? `&where=${encodeURIComponent(query)}` : ''}`);
  await page.locator('.count', { hasText: /results$/ }).waitFor();
}
async function clipboard(click: () => Promise<unknown>, expected: string) {
  await secure.bringToFront();
  await secure.evaluate(() => navigator.clipboard.writeText('unchanged sentinel'));
  await page.bringToFront();
  await click();
  await page.getByRole('status').filter({ hasText: /^Copied$/ }).first().waitFor();
  await secure.bringToFront();
  assert.equal(await secure.evaluate(() => navigator.clipboard.readText()), expected);
  await page.bringToFront();
}

test('HTTP chart saves, new tiles and duplicates persist with distinct UUIDs', async () => {
  assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID, typeof navigator.clipboard]), [false, 'undefined', 'undefined']);
  await page.goto(`${base}/chart`);
  await page.getByRole('button', { name: 'Save to dashboard', exact: true }).click();
  let modal = page.getByRole('dialog', { name: 'Save to dashboard', exact: true });
  await modal.getByLabel('Tile title', { exact: true }).fill('HTTP chart');
  await modal.getByLabel('New dashboard name', { exact: true }).fill('HTTP dashboard');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('region', { name: 'HTTP chart', exact: true }).waitFor();
  dashboardId = Number(new URL(page.url()).pathname.split('/').at(-1));
  await page.goto(`${base}/chart`);
  await page.getByRole('button', { name: 'Save to dashboard', exact: true }).click();
  modal = page.getByRole('dialog', { name: 'Save to dashboard', exact: true });
  await modal.locator('#tile-dashboard').selectOption(String(dashboardId));
  await modal.getByLabel('Tile title', { exact: true }).fill('HTTP existing');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('region', { name: 'HTTP existing', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New Tile', exact: true }).click();
  modal = page.getByRole('dialog', { name: 'New tile', exact: true });
  await modal.getByLabel('Title', { exact: true }).fill('HTTP tile');
  await modal.getByRole('button', { name: 'Add tile', exact: true }).click();
  await page.getByRole('button', { name: 'Tile menu HTTP tile', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  await page.getByRole('region', { name: 'HTTP tile (copy)', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('region', { name: 'HTTP tile (copy)', exact: true }).waitFor();
  const { tiles } = await api(`/api/dashboards/${dashboardId}`);
  assert.equal(tiles.length, 4);
  assert.equal(new Set(tiles.map((t: { id: string }) => t.id)).size, 4);
  for (const tile of tiles) assert.match(tile.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});

test('HTTP copies trace ID, property, row JSON and API key into the actual clipboard', async () => {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/search');
  await search('level:ERROR');
  const data = await (await response).json();
  const first = data.rows[0];
  await page.locator('table.results tbody tr').first().click();
  const panel = page.getByLabel('Event details', { exact: true });
  await clipboard(() => panel.getByRole('button', { name: 'Copy Trace ID', exact: true }).click(), first.trace_id);
  await clipboard(() => panel.getByRole('button', { name: 'Copy service_name', exact: true }).first().click(), first.service_name);
  await panel.getByRole('tab', { name: 'Column Values', exact: true }).click();
  await clipboard(() => panel.getByRole('button', { name: 'Copy row as JSON', exact: true }).click(), JSON.stringify(first, null, 2));
  await page.goto(`${base}/team`);
  await page.getByLabel('New key name').fill('HTTP clipboard');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const key = await page.getByTestId('new-key').innerText();
  await clipboard(() => page.locator('.fresh-key').getByRole('button', { name: 'Copy', exact: true }).click(), key);
  await page.getByRole('button', { name: 'Revoke HTTP clipboard', exact: true }).click();
});

test('sessions without replay retain timeline filters, details and trace navigation', async () => {
  await page.goto(`${base}/sessions?session=${sessionId}&from=${Date.now() - 60000}&to=${Date.now() + 60000}`);
  const events = page.getByRole('complementary', { name: 'Session events' });
  await events.locator('li').first().waitFor();
  assert.equal(await events.locator('li').count(), 3);
  assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).count(), 0);
  assert.deepEqual(await events.locator('.ev .mono').allInnerTexts(), ['0:00', '0:01', '0:02']);
  await events.getByRole('tab', { name: /^Errors/ }).click();
  assert.equal(await events.locator('li').count(), 2);
  await events.locator('li', { hasText: 'No replay error' }).locator('.ev').click();
  assert.match(await events.locator('.ev-detail').innerText(), /"reason": "test"/);
  await events.getByRole('tab', { name: /^Network/ }).click();
  await events.locator('.ev').click();
  await events.getByRole('button', { name: 'Open trace', exact: true }).click();
  await page.waitForURL(/openTrace=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test('invalid dates remain in the time form and valid leap dates apply', async () => {
  await search();
  await page.getByRole('button', { name: 'Time Range', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Time Range', exact: true });
  await dialog.getByLabel('Start time').fill('2026-02-31 10:00:00');
  await dialog.getByLabel('End time').fill('2026-03-05 12:00:00');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await dialog.isVisible(), true);
  await dialog.locator('.tp-error').waitFor();
  await dialog.getByLabel('Start time').fill('2024-02-29 10:00:00');
  await dialog.getByLabel('End time').fill('2024-02-29 12:00:00');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).searchParams.get('from'), String(new Date('2024-02-29T02:00:00Z').getTime()));
});

test('Live Tail pauses while inspecting a row and resumes on request', async () => {
  await page.goto(`${base}/search?source=logs&t=live&where=${encodeURIComponent(`service:${service}`)}`);
  await page.locator('table.results tbody tr').first().waitFor();
  await page.getByLabel('Live tail refresh interval').selectOption('1');
  await page.locator('table.results tbody tr').first().click();
  await page.getByRole('button', { name: 'Resume Live Tail', exact: true }).waitFor();
  let polls = 0;
  const listener = (r: { url(): string }) => { if (new URL(r.url()).pathname === '/api/search') polls++; };
  page.on('request', listener);
  await page.waitForTimeout(2200);
  page.off('request', listener);
  assert.equal(polls, 0);
  await page.keyboard.press('Escape');
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/search' && r.status() === 200);
  await page.getByRole('button', { name: 'Resume Live Tail', exact: true }).click();
  await response;
});

test('facet values expand beyond ten and server search reaches beyond the top hundred', async () => {
  await search(`service:${service}`);
  const facet = page.getByRole('region', { name: 'service_instance_id', exact: true });
  await facet.locator('.facet-value').first().waitFor();
  assert.equal(await facet.locator('.facet-value').count(), 10);
  await facet.getByRole('button', { name: /Show more/ }).click();
  assert.equal(await facet.locator('.facet-value').count(), 100);
  const all = (await api(`/api/facets?source=logs&fields=service_instance_id&where=${encodeURIComponent(`service:${service}`)}&from=${new Date(Date.now() - 60000).toISOString()}&to=${new Date(Date.now() + 60000).toISOString()}`)).facets[0].values;
  const missing = Array.from({ length: 125 }, (_, i) => `instance-${String(i).padStart(3, '0')}`).find((v) => !all.some((x: { v: string }) => x.v === v))!;
  assert.ok(missing);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/facets' && new URL(r.url()).searchParams.get('value') === missing);
  await facet.getByLabel('Search service_instance_id values').fill(missing);
  assert.equal((await response).status(), 200);
  await facet.getByLabel(`service_instance_id = ${missing}`, { exact: true }).check();
  await page.waitForFunction((value) => new URLSearchParams(location.search).get('filters')?.includes(value), missing);
  await page.locator('.count', { hasText: /^1 results$/ }).waitFor();
});

test('phone chart, sessions and map controls and time forms fit at 390px and 320px', async () => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/chart', '/sessions', '/service-map']) {
      await page.goto(`${base}${path}`);
      await page.locator('.chart-page-head').waitFor();
      const controls = page.locator('.chart-page-head').locator('button,input,select');
      for (const control of await controls.all()) {
        const box = await control.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${path}: header control fits ${width}px`);
      }
      await page.getByRole('button', { name: 'Time Range', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Time Range', exact: true });
      const box = (await dialog.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 844, `${path}: time form fits ${width}px`);
      await dialog.getByRole('button', { name: 'Last 7 days', exact: true }).click();
      if (path === '/chart') {
        await page.getByRole('button', { name: 'Save to dashboard', exact: true }).click();
        await page.getByRole('dialog', { name: 'Save to dashboard', exact: true }).waitFor();
        await page.keyboard.press('Escape');
      }
    }
  }
});
