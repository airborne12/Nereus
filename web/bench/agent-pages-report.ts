// Times the session page of one agent session in headless Chromium against a running Nereus:
// opening the page, and selecting steps with many turns open. Times are taken inside the page.
//
//   NEREUS_URL=http://127.0.0.1:8090 NEREUS_EMAIL=... NEREUS_PASSWORD=... \
//     node bench/agent-pages-report.ts <session id> [turns to open, 300 by default]

import { chromium } from 'playwright';

const base = process.env.NEREUS_URL ?? 'http://127.0.0.1:8090';
const [id, turns] = process.argv.slice(2);
if (!id || !process.env.NEREUS_EMAIL || !process.env.NEREUS_PASSWORD) {
  console.error('usage: NEREUS_URL=... NEREUS_EMAIL=... NEREUS_PASSWORD=... node bench/agent-pages-report.ts <session id> [turns to open]');
  process.exit(1);
}
const want = Number(turns ?? 300);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`${base}/`);
const signedIn = await page.evaluate(async ([email, password]) => {
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.ok;
}, [process.env.NEREUS_EMAIL, process.env.NEREUS_PASSWORD]);
if (!signedIn) {
  console.error('sign-in failed');
  await browser.close();
  process.exit(1);
}

const listHeight = () => page.evaluate(() => document.querySelector('.ag-tree')!.scrollHeight);
const drawn = async () => `${await page.locator('.ag-trow').count()} rows drawn, ${await page.evaluate(() => document.querySelectorAll('*').length)} elements`;

// Opening: from the start of the navigation to the first rows and the first content on the right.
const opens: { total: number; api: number }[] = [];
for (let i = 0; i < 5; i += 1) {
  await page.goto(`${base}/agents/sessions/${encodeURIComponent(id)}`);
  await page.locator('.ag-trow').first().waitFor();
  await page.locator('.ag-pane .ag-io').first().waitFor();
  opens.push(await page.evaluate(() => {
    const calls = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((r) => r.name.includes('/api/agents/sessions/'));
    const api = calls.map((r) => r.responseEnd - r.startTime);
    return { total: performance.now(), api: Math.max(...api) };
  }));
}
console.log(`open: ${Math.round(median(opens.map((o) => o.total)))} ms median to the lanes and the first content, the slowest API call ${Math.round(median(opens.map((o) => o.api)))} ms`);
console.log(`closed: list ${await listHeight()} px high, ${await drawn()}`);

// Open turns from the top down, inside the page: a click, then two frames for the row to redraw.
const opened = await page.evaluate(async (limit) => {
  const tree = document.querySelector('.ag-tree')!;
  const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  let n = 0;
  while (n < limit) {
    const twist = document.querySelector<HTMLElement>('.ag-trow.turn.closed .ag-tw');
    if (twist) {
      twist.click();
      n += 1;
      await frames();
      continue;
    }
    if (tree.scrollTop + tree.clientHeight >= tree.scrollHeight - 2) break;
    tree.scrollTop += 500;
    await frames();
  }
  return n;
}, want);
await page.waitForFunction(() => !document.querySelector('.ag-trow.more .ag-dim'), null, { timeout: 120_000 });
const height = await listHeight();
console.log(`${opened} turns open: list ${height} px high, ${await drawn()}`);

// Selecting a step at places down the list: to the frame in which its row is marked, and to its content on the right.
const marked: number[] = [];
const shown: number[] = [];
for (let i = 0; i < 30; i += 1) {
  await page.evaluate((top) => { document.querySelector('.ag-tree')!.scrollTop = top; }, Math.floor((i / 30) * height));
  await page.waitForTimeout(60);
  const step = page.locator('.ag-trow.step:not(.sel)').first();
  if (!(await step.count())) continue;
  const key = await step.getAttribute('data-key');
  const t = await page.evaluate(async (k) => {
    const row = (cls: string) => [...document.querySelectorAll<HTMLElement>(cls)].find((n) => n.dataset.key === k);
    const t0 = performance.now();
    row('.ag-trow.step')!.click();
    const until = (done: () => boolean) => new Promise<void>((resolve) => {
      const check = () => (done() ? resolve() : requestAnimationFrame(check));
      check();
    });
    await until(() => row('.ag-trow.sel') !== undefined);
    const mark = performance.now() - t0;
    await until(() => document.querySelector('.ag-pane .ag-io') !== null);
    return { mark, content: performance.now() - t0 };
  }, key);
  marked.push(t.mark);
  shown.push(t.content);
}
console.log(`select a step (${marked.length} steps): ${Math.round(median(marked))} ms median to the marked row (max ${Math.round(Math.max(...marked))}), `
  + `${Math.round(median(shown))} ms median to its content (max ${Math.round(Math.max(...shown))})`);
await browser.close();
