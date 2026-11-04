// Offline demo: answers the UI's /api/* calls in the browser from a snapshot of real rows
// (demo-data.json), shifted so the newest row is "now". Built with `npm run build:demo`.

import { histogramStep } from '../../../server/src/query/build.ts';
import { unknownFields } from '../../../server/src/query/compile.ts';
import { logsSource, tracesSource, type Source } from '../../../server/src/query/source.ts';
import { compileFilter, type DemoRow, fieldValue } from './evaluate.ts';

interface Snapshot {
  logs: DemoRow[];
  traces: DemoRow[];
  fields: Record<string, { name: string; type: string }[]>;
}

const VARIANTS = ['resource_attributes', 'log_attributes', 'span_attributes'];
const sources: Record<string, Source> = { logs: logsSource('demo'), traces: tracesSource('demo') };

const msOf = (t: string) => Date.parse(`${t.replace(' ', 'T')}Z`);
function shiftTime(t: string, offset: number): string {
  // Keep the microseconds beyond the millisecond.
  const micros = /\.\d{3}(\d*)$/.exec(t)?.[1] ?? '';
  return new Date(msOf(t) + offset).toISOString().replace('T', ' ').replace('Z', '') + micros;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function banner(rows: number, spans: number, minutes: number): void {
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  bar.textContent = `演示版：${minutes} 分钟的真实数据快照（${rows.toLocaleString()} 条日志、${spans.toLocaleString()} 个 span），` +
    '时间已平移到现在；查询在浏览器里按 Doris 的规则计算，不连接 Doris。';
  document.body.classList.add('demo');
  document.body.prepend(bar);
}

export async function install(): Promise<void> {
  const res = await fetch(new URL('demo-data.json', document.baseURI));
  const snap = (await res.json()) as Snapshot;
  const newest = Math.max(...[...snap.logs, ...snap.traces].map((r) => msOf(String(r.timestamp))));
  const offset = Date.now() - newest - 5_000;
  for (const rows of [snap.logs, snap.traces]) {
    for (const r of rows) {
      r.timestamp = shiftTime(String(r.timestamp), offset);
      if (typeof r.end_time === 'string') r.end_time = shiftTime(r.end_time, offset);
      for (const v of VARIANTS) if (typeof r[v] === 'string') r[v] = JSON.parse(r[v] as string);
      r._ms = msOf(String(r.timestamp));
    }
    rows.sort((a, b) => (b._ms as number) - (a._ms as number));
  }
  const data: Record<string, DemoRow[]> = { logs: snap.logs, traces: snap.traces };
  const all = [...snap.logs, ...snap.traces].map((r) => r._ms as number);
  banner(snap.logs.length, snap.traces.length, Math.round((Math.max(...all) - Math.min(...all)) / 60_000));
  const strip = (r: DemoRow) => {
    const { _ms, ...rest } = r;
    void _ms;
    return rest;
  };

  let user: { id: number; email: string; name: string; role: 'admin' } | null =
    { id: 1, email: 'demo@example.com', name: 'Demo', role: 'admin' };
  const keys: { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }[] = [];
  const users = [{ id: 1, email: 'demo@example.com', name: 'Demo', role: 'admin', disabled: false }];

  function inWindow(p: URLSearchParams, rows: DemoRow[]): DemoRow[] {
    const from = Date.parse(p.get('from') ?? ''), to = Date.parse(p.get('to') ?? '');
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('invalid time range');
    return rows.filter((r) => (r._ms as number) >= from && (r._ms as number) < to);
  }

  async function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const p = url.searchParams;
    const path = url.pathname.replace(/^.*\/api\//, '/api/');
    const source = sources[p.get('source') ?? ''];
    if (path === '/api/auth/status') return json(200, { setupRequired: false, user });
    if (path === '/api/auth/login') {
      user = { id: 1, email: String((body as { email?: string })?.email ?? 'demo@example.com'), name: 'Demo', role: 'admin' };
      return json(200, { user });
    }
    if (path === '/api/auth/logout') { user = null; return json(200, { ok: true }); }
    if (!user) return json(401, { error: 'login required' });
    try {
      if (path === '/api/fields' && source) return json(200, { fields: snap.fields[source.name] });
      if (path === '/api/search' && source) {
        const t0 = performance.now();
        const q = p.get('q') ?? '';
        const match = compileFilter(source, q);
        const limit = Number(p.get('limit') ?? 200);
        const rows = inWindow(p, data[source.name]!).filter(match).slice(0, limit).map(strip);
        const warnings = unknownFields(source, q, snap.fields[source.name]!.map((f) => f.name))
          .map((u) => ({ kind: 'unknown_field', ...u }));
        return json(200, { rows, warnings, elapsedMs: Math.round(performance.now() - t0) });
      }
      if (path === '/api/histogram' && source) {
        const from = Date.parse(p.get('from')!), to = Date.parse(p.get('to')!);
        const [step] = histogramStep(from, to, Number(p.get('buckets') ?? 120));
        const match = compileFilter(source, p.get('q') ?? '');
        const group = p.get('groupBy');
        const counts = new Map<string, number>();
        for (const r of inWindow(p, data[source.name]!)) {
          if (!match(r)) continue;
          const t = Math.floor((r._ms as number) / (step * 1000)) * step * 1000;
          const key = `${t}|${group ? String(r[group] ?? '') : ''}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const buckets = [...counts.entries()].map(([k, n]) => {
          const [t, g] = k.split('|');
          return { t: new Date(Number(t)).toISOString().replace('T', ' ').replace('Z', ''), ...(group ? { g } : {}), n };
        });
        return json(200, { stepSeconds: step, buckets });
      }
      if (path === '/api/values' && source) {
        const field = p.get('field')!;
        const match = compileFilter(source, p.get('q') ?? '');
        const counts = new Map<string, number>();
        for (const r of inWindow(p, data[source.name]!)) {
          if (!match(r)) continue;
          const v = fieldValue(source, r, field);
          if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const values = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(p.get('limit') ?? 10))
          .map(([v, n]) => ({ v, n }));
        return json(200, { values });
      }
      const trace = /^\/api\/trace\/([0-9a-f]{32})$/.exec(path);
      if (trace) return json(200, { spans: data.traces!.filter((r) => r.trace_id === trace[1]).reverse().map(strip) });
      if (path === '/api/keys' && method === 'GET') return json(200, { keys });
      if (path === '/api/keys' && method === 'POST') {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const key = `dsk_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
        const apiKey = { id: keys.length + 1, name: String((body as { name?: string }).name), prefix: key.slice(0, 12),
          createdAt: new Date().toISOString(), lastUsedAt: null, revoked: false };
        keys.unshift(apiKey);
        return json(201, { key, apiKey });
      }
      const del = /^\/api\/keys\/(\d+)$/.exec(path);
      if (del) { const k = keys.find((x) => x.id === Number(del[1])); if (k) k.revoked = true; return json(200, { ok: true }); }
      if (path === '/api/users' && method === 'GET') return json(200, { users });
      if (path === '/api/users' && method === 'POST') {
        const b = body as { email: string; name: string; role: 'admin' | 'member' };
        users.push({ id: users.length + 1, email: b.email, name: b.name, role: b.role, disabled: false });
        return json(201, { user: users.at(-1) });
      }
      const dis = /^\/api\/users\/(\d+)\/disabled$/.exec(path);
      if (dis) { const u = users.find((x) => x.id === Number(dis[1])); if (u) u.disabled = Boolean((body as { disabled: boolean }).disabled); return json(200, { user: u }); }
      return json(404, { error: 'not found' });
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, document.baseURI);
    if (!url.pathname.includes('/api/')) return realFetch(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return handle(init?.method ?? 'GET', url, body);
  };
}
