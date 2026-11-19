// Browser test of the Memories pages against a live Doris and PostgreSQL: two sessions written by
// hand (one writes a memory, a later one reads it) and memories captured from Claude Code and
// Gemini CLI stores. Starts the API service in-process (serving web/dist) and walks the Memories
// table, a memory's page and the session that wrote it, in headless Chromium.
//
//   npm run build && DORIS_BE_HTTP_URL=http://127.0.0.1:8040 SHOTS=/tmp/shots node --test e2e/memories.e2e.ts

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
import { Leases } from '../../server/src/jobs/leases.ts';
import { captureStores } from '../../server/src/jobs/memories.ts';
import { IngestKeys } from '../../server/src/rum/http.ts';
import { readClaudeMemory } from '../../server/src/semantics/memories/claude-memory.ts';
import { readGeminiMemories } from '../../server/src/semantics/memories/gemini-memory.ts';
import { createApp } from '../../server/src/server.ts';
import { MEMORY_DIR, READER_ID, WRITER_ID, writeMemorySessions } from '../../server/test/fixtures/memory-transcript.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';
import { applySchemaFile } from '../../server/test/schema-helper.ts';

const shots = process.env.SHOTS;
const db = `nereus_memory_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
/** The browser's clock: the day after the memories were captured. */
const NOW = Date.parse('2026-11-19T12:00:00Z');
const LATER = Date.parse('2026-11-18T09:00:00Z');
const BUILD = [
  '---', 'name: build-cache-flag', 'description: The build reuses its cache only with the keep flag', 'metadata:', '  type: feedback',
  `  originSessionId: ${WRITER_ID}`, '  modified: 2026-11-17T12:00:30.000Z', '---', 'Run make with --keep to reuse the cache.', '', '## Why', 'A clean build takes <b>forty</b> minutes.',
].join('\n');
const STAGING = 'The staging deploy pipeline waits for the artifact registry mirror, and uploads again after each timeout.';
const errors: string[] = [];
let browser: Browser;
let page: Page;
let base = '';
let dir = '';
let stop: () => Promise<void> = async () => {};

before(async () => {
  const doris = new Doris(configFromEnv());
  let drop = async () => {};
  let closeServer = async () => {};
  stop = async () => {
    await browser?.close();
    await closeServer();
    await drop();
    try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
  };
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-memory-e2e-'));
  for (const file of writeMemorySessions(dir)) await importFile(file, { doris, db, load });
  const meta = await freshMetaDb();
  drop = () => meta.drop();
  const report = await captureStores({ doris, db, load, leases: new Leases(meta.pool), now: () => new Date('2026-11-18T10:00:00Z') }, [
    { agent: 'claude-code', scope: '-home-u-work', memories: [['build-cache-flag', BUILD], ['staging-deploy', STAGING]].map(([n, t]) => readClaudeMemory(`${MEMORY_DIR}/${n}.md`, t!, LATER)!) },
    { agent: 'gemini-cli', scope: 'global', memories: readGeminiMemories('/home/u/.gemini/GEMINI.md', '## Gemini Added Memories\n- Use pnpm here.\n', 'global', LATER) },
  ]);
  assert.deepEqual([report.written, report.inferred], [3, 1]);
  const auth = new AuthStore(meta.pool);
  await auth.setup('admin@example.com', 'Ada Admin', 'adminpass1');
  const webDir = new URL('../dist', import.meta.url).pathname;
  const server = createApp({ doris, db, auth: { store: auth, secureCookie: false }, content: new ContentStore(meta.pool), ingestKeys: new IngestKeys(meta.pool), webDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closeServer = () => new Promise<void>((r) => server.close(() => r()));
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
});
after(async () => {
  await stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const shot = (name: string) => (shots ? page.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve());
const total = (t: string) => page.locator('.ag-total', { hasText: new RegExp(`^${t}$`) }).waitFor();
const headers = async () => (await page.locator('.ag-table thead th button').allInnerTexts()).map((t) => t.replace(/[↑↓]/g, '').trim());
const rows = () => page.locator('.ag-table tbody tr:not(.ag-none):not(.ag-more)');
const row = (name: string) => rows().filter({ has: page.locator('b', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const cells = async (name: string) => (await row(name).locator('td').allInnerTexts()).map((t) => t.trim());

test('Memories is a page of the navigation after Judges: the latest version of each memory, its state and its source', async () => {
  const nav = await page.getByRole('navigation').locator('.nav-item').allInnerTexts();
  assert.ok(nav.indexOf('Memories') === nav.indexOf('Judges') + 1, nav.join(', '));
  await page.getByRole('navigation').getByRole('button', { name: 'Memories', exact: true }).click();
  await page.waitForURL(`${base}/agents/memories`);
  await page.getByRole('heading', { name: 'Memories', level: 1 }).waitFor();
  await total('3 memories');
  assert.deepEqual(await headers(), ['Updated', 'Agent', 'Scope', 'Memory', 'Kind', 'Still valid', 'Source session']);
  assert.equal(await page.locator('.ag-pages').count(), 0, 'Memories is not a sibling of the Sessions pages');
  assert.deepEqual(await cells('build-cache-flag'), ['2026-11-17 12:00:30', 'claude-code', '-home-u-work', 'build-cache-flag · The build reuses its cache only with the keep flag', 'feedback', 'Not judged yet', 'Remember the keep flag']);
  const staging = await cells('staging-deploy');
  assert.deepEqual(staging.slice(5, 6), ['Not used since written']);
  assert.match(staging[6]!, /^inferred · \d+ % of words$/);
  assert.deepEqual((await cells('Use pnpm here.')).slice(5), ['Use not recorded', 'Not recorded']);
  await shot('memory-01-table');
  await page.getByLabel('Search names, descriptions and contents').fill('artifact registry');
  await total('1 memory');
  await page.getByLabel('Search names, descriptions and contents').fill('');
  await total('3 memories');
});

test('an inferred source opens the session it was inferred from', async () => {
  await row('staging-deploy').getByRole('button', { name: /^inferred/ }).click();
  await page.waitForURL((u) => u.pathname === `/agents/sessions/${READER_ID}`);
  await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Slow staging deploys' }).waitFor();
  await page.getByRole('button', { name: '← Memories' }).click();
  await page.waitForURL(`${base}/agents/memories`);
});

test("a memory's page: its fields and where its agent keeps them, whether it is used, the calls on its file, its content and versions", async () => {
  await row('build-cache-flag').click();
  await page.waitForURL((u) => u.pathname === '/agents/memories/claude-code/-home-u-work/build-cache-flag');
  await page.getByRole('heading', { name: 'build-cache-flag', level: 1 }).waitFor();
  const fields = page.getByRole('table', { name: 'Fields' });
  await fields.locator('tbody tr').first().waitFor();
  assert.deepEqual((await fields.locator('tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()), [
    'Name build-cache-flag name in the frontmatter, else the file name',
    'Description The build reuses its cache only with the keep flag description in the frontmatter',
    'Kind feedback metadata.type in the frontmatter',
    'Updated 2026-11-17 12:00:30 metadata.modified in the frontmatter, else the time of the file',
    `Source Remember the keep flag (${WRITER_ID}) metadata.originSessionId in the frontmatter`,
    'Content Below, by its sections the file after its frontmatter, by its own headings',
  ]);
  assert.equal(await fields.locator('th').nth(2).textContent(), 'Where claude-code keeps it');
  const valid = page.getByRole('region', { name: 'Still valid?' });
  assert.match(await valid.locator('.mem-state').innerText(), /^Not judged yet\s+A session has read it since it was last written/);
  const uses = (await valid.getByRole('table').locator('tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.equal(uses.length, 2);
  assert.match(uses[0]!, /^2026-11-17 15:00:\d\d Slow staging deploys Read · step \d+$/);
  assert.match(uses[1]!, /^2026-11-17 12:00:\d\d Remember the keep flag Write · step \d+$/);
  const content = page.getByRole('region', { name: 'Content' });
  assert.deepEqual(await content.locator('h3').allInnerTexts(), ['Why']);
  assert.match(await content.innerText(), /A clean build takes <b>forty<\/b> minutes\./, 'markup in a memory shows as text');
  assert.equal(await page.getByRole('table', { name: 'Versions' }).locator('tbody tr').count(), 1);
  await shot('memory-02-page');
  // A call on its file opens that step of the session.
  await valid.getByRole('table').locator('tbody tr').first().click();
  await page.waitForURL((u) => u.pathname === `/agents/sessions/${READER_ID}` && (u.searchParams.get('sel') ?? '').startsWith(`s:${READER_ID}:`));
});

test('the session that wrote a memory says so in its header, and opens the memory', async () => {
  await page.goto(`${base}/agents/sessions/${WRITER_ID}`);
  const wrote = page.getByRole('button', { name: 'Wrote memory build-cache-flag' });
  await wrote.waitFor();
  await shot('memory-03-session');
  await wrote.click();
  await page.waitForURL((u) => u.pathname.endsWith('/build-cache-flag'));
  await page.getByRole('heading', { name: 'build-cache-flag', level: 1 }).waitFor();
  await page.goto(`${base}/agents/sessions/${READER_ID}`);
  await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Slow staging deploys' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Wrote memory/ }).count(), 0, 'reading a memory is not writing it');
});

test("a Gemini CLI memory's use is not recorded, and its page says where Gemini keeps it", async () => {
  await page.goto(`${base}/agents/memories/gemini-cli/global/${encodeURIComponent('Use pnpm here.')}`);
  await page.getByRole('heading', { name: 'Use pnpm here.', level: 1 }).waitFor();
  assert.match(await page.locator('.mem-state').innerText(), /^Use not recorded\s+gemini-cli loads it whole into every session/);
  assert.deepEqual((await page.getByRole('table', { name: 'Fields' }).locator('tbody td:nth-child(3)').allInnerTexts()), [
    'the first 200 characters of the bullet', 'the time of the GEMINI.md file', 'a bullet under "## Gemini Added Memories" in GEMINI.md',
  ]);
  await page.goto(`${base}/agents/memories/claude-code/-home-u-work/no-such-memory`);
  await page.getByRole('alert').filter({ hasText: 'no such memory' }).waitFor();
});

test('the dark theme and a 400 px window', async () => {
  const context = await browser.newContext({ viewport: { width: 400, height: 800 }, timezoneId: 'UTC', colorScheme: 'dark', storageState: await page.context().storageState() });
  const small = await context.newPage();
  await small.clock.setFixedTime(NOW);
  small.on('pageerror', (e) => errors.push(e.message));
  for (const url of [`${base}/agents/memories`, `${base}/agents/memories/claude-code/-home-u-work/build-cache-flag`]) {
    await small.goto(url);
    await small.locator('.ag-page h1').waitFor();
    await small.locator('.ag-table tbody tr').first().waitFor();
    assert.ok(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), url);
  }
  if (shots) await small.screenshot({ path: `${shots}/memory-04-dark-400.png` });
  await context.close();
});

test('no page raised an error', () => {
  assert.deepEqual(errors, []);
});
