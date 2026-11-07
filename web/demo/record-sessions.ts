// Records a few browser sessions on the example shop (sdk-example/shop.html) through the real SDK
// and ingestion API, for the offline demo's snapshot. Runs the API service in-process on a fresh
// metadata database; the rows land in DORIS_DB.otel_sessions. Prints the session ids.
//
//   npm run build && DORIS_PORT=9930 DORIS_DB=otel_bench node demo/record-sessions.ts

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { AuthStore } from '../../server/src/auth/store.ts';
import { ContentStore } from '../../server/src/content/store.ts';
import { Doris, configFromEnv } from '../../server/src/db.ts';
import { createApp } from '../../server/src/server.ts';
import { IngestKeys } from '../../server/src/sessions/http.ts';
import { freshMetaDb } from '../../server/test/meta-helper.ts';

const doris = new Doris(configFromEnv());
const meta = await freshMetaDb();
const keys = new IngestKeys(meta.pool);
const admin = await new AuthStore(meta.pool).setup('admin@example.com', 'Admin', 'adminpass1');
const { key } = await keys.create(admin.id, 'demo');
const app = createApp({ doris, db: process.env.DORIS_DB ?? 'otel_bench', auth: { store: new AuthStore(meta.pool), secureCookie: false },
  content: new ContentStore(meta.pool), ingestKeys: keys, webDir: new URL('../dist', import.meta.url).pathname });
await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
const html = readFileSync(new URL('../sdk-example/shop.html', import.meta.url), 'utf8');
const DB = process.env.DORIS_DB ?? 'otel_bench';
// The shop's backend continues the browser's traceparent in a server span, as OTel would.
const shop = createServer((req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/api/checkout')) {
    const [, traceId, parent] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(String(req.headers.traceparent ?? '')) ?? [];
    if (!traceId) return res.writeHead(400).end('no traceparent');
    const t = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const span = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('');
    return void doris.query(`INSERT INTO ${DB}.otel_traces (service_name, timestamp, trace_id, span_id, parent_span_id, span_name, span_kind, duration, status_code, status_message, is_root) ` +
      `VALUES ('acme-api', '${t}', '${traceId}', '${span}', '${parent}', 'POST /api/checkout', 'SPAN_KIND_SERVER', 41000, 'STATUS_CODE_ERROR', 'payment service unavailable', 0)`)
      .then(() => res.writeHead(503).end('down'));
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(html);
});
await new Promise<void>((r) => shop.listen(0, '127.0.0.1', r));
const shopUrl = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;

const browser = await chromium.launch();
async function visit(user: string, steps: (p: Page) => Promise<void>): Promise<string> {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const p = await ctx.newPage();
  await p.goto(`${shopUrl}/?ds=${encodeURIComponent(base)}&key=${encodeURIComponent(key)}&user=${encodeURIComponent(user)}`);
  await p.waitForFunction(() => (window as any).dsReady === true);
  await steps(p);
  await p.waitForTimeout(400);
  const id = await p.evaluate(async () => { await (window as any).NereusRUM.flush(); return (window as any).NereusRUM.sessionId(); });
  await ctx.close();
  return id;
}
const pause = (p: Page, ms: number) => p.waitForTimeout(ms);
const ids = [
  await visit('ada@example.com', async (p) => {
    await pause(p, 1500); await p.click('#add-teapot'); await pause(p, 900); await p.click('#add-mug'); await pause(p, 1200);
    await p.click('#nav-cart'); await pause(p, 1000); await p.click('#card'); await p.type('#card', '4111 1111 1111 1111', { delay: 60 });
    await pause(p, 800); await p.click('#checkout'); await pause(p, 1500);
  }),
  await visit('grace@example.com', async (p) => {
    await pause(p, 1000); await p.click('#add-kettle'); await pause(p, 1500); await p.click('#nav-cart'); await pause(p, 1200);
    await p.click('#nav-products'); await pause(p, 800); await p.click('#add-mug'); await pause(p, 1000);
  }),
  await visit('linus@example.com', async (p) => {
    await pause(p, 700); await p.mouse.move(400, 300, { steps: 20 }); await pause(p, 600); await p.click('#nav-cart'); await pause(p, 700);
    await p.click('#checkout'); await pause(p, 1200); await p.click('#checkout'); await pause(p, 1000);
  }),
];
console.log(JSON.stringify(ids));
await browser.close();
await new Promise<void>((r) => shop.close(() => r()));
await new Promise<void>((r) => app.close(() => r()));
await doris.close();
await meta.drop();
