// Offline demo: answers the UI's /api/* calls in the browser from a snapshot of real rows
// (demo-data.json), shifted so the newest row is "now". Built with `npm run build:demo`.

import {
  defaultFacetFields, facetsSql, histogramStep, searchHistogramSql, searchRowsSql, selectColumns, type Filter, type SearchSpec,
} from '../../../server/src/query/build.ts';
import { unknownFields } from '../../../server/src/query/compile.ts';
import { logsSource, metricsSource, tracesSource, type Source } from '../../../server/src/query/source.ts';
import { createDemoContent } from './content.ts';
import { compileFilter, type DemoRow, fieldValue } from './evaluate.ts';

interface Snapshot {
  logs: DemoRow[];
  traces: DemoRow[];
  metrics?: DemoRow[];
  fields: Record<string, { name: string; type: string }[]>;
}

const VARIANTS = ['resource_attributes', 'log_attributes', 'span_attributes', 'attributes'];
const sources: Record<string, Source> = { logs: logsSource('demo'), traces: tracesSource('demo'), metrics: metricsSource('demo') };

const msOf = (t: string) => Date.parse(`${t.replace(' ', 'T')}Z`);
function shiftTime(t: string, offset: number): string {
  // Keep the microseconds beyond the millisecond.
  const micros = /\.\d{3}(\d*)$/.exec(t)?.[1] ?? '';
  return new Date(msOf(t) + offset).toISOString().replace('T', ' ').replace('Z', '') + micros;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function specOf(p: URLSearchParams): SearchSpec {
  const raw = p.get('filters');
  return {
    where: p.get('where') ?? p.get('q') ?? '', language: p.get('language') === 'sql' ? 'sql' : 'lucene',
    filters: raw ? (JSON.parse(raw) as Filter[]) : [], from: p.get('from')!, to: p.get('to')!,
  };
}

/** WHERE (Lucene) and the facet filters, as the server ANDs them. */
function matcher(source: Source, spec: SearchSpec): (r: DemoRow) => boolean {
  const where = compileFilter(source, spec.where);
  const filters = (spec.filters ?? []).map((f) => {
    const set = new Set(f.values.map(String));
    return (r: DemoRow) => {
      const v = fieldValue(source, r, f.field);
      const hit = v !== null && set.has(v);
      return f.exclude ? !hit : hit;
    };
  });
  return (r) => where(r) && filters.every((f) => f(r));
}

function defaultSelectOf(source: Source): string {
  return source.name === 'traces'
    ? 'timestamp, service_name, status_code, round(duration / 1000, 1), span_name'
    : 'timestamp, service_name, severity_text, body';
}

/** ORDER BY one column, ASC or DESC (the demo's limit); the default is newest first. */
function sortRows(rows: DemoRow[], orderBy: string | null): DemoRow[] {
  if (!orderBy?.trim()) return rows;
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(ASC|DESC)?\s*$/i.exec(orderBy);
  if (!m) throw new Error('The offline demo sorts by one column only, e.g. "duration DESC".');
  const col = m[1]!, desc = (m[2] ?? 'ASC').toUpperCase() === 'DESC';
  const key = (r: DemoRow) => (col === 'timestamp' ? (r._ms as number) : r[col]);
  return [...rows].sort((a, b) => {
    const x = key(a), y = key(b);
    const c = typeof x === 'number' || !Number.isNaN(Number(x)) ? Number(x) - Number(y) : String(x).localeCompare(String(y));
    return desc ? -c : c;
  });
}

/** Values of the SELECT list's extra expressions: fields, arithmetic, round/upper/lower/abs. */
function withExtras(source: Source, row: DemoRow, extra: string[]): DemoRow {
  const out = { ...row };
  for (const e of extra) {
    const m = /^(.*) AS (__e\d+)$/.exec(e)!;
    out[m[2]!] = evalExpr(source, row, m[1]!);
  }
  return out;
}

function evalExpr(source: Source, row: DemoRow, expr: string): unknown {
  const field = /^coalesce\(CAST\((\w+)\['([^']+)'\] AS STRING\)/.exec(expr) ?? /^CAST\((\w+)\['([^']+)'\] AS STRING\)$/.exec(expr);
  if (field) return fieldValue(source, row, field[2]!);
  if (/^[A-Za-z_]\w*$/.test(expr)) return row[expr] ?? null;
  const toks = expr.match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|[-+*/(),]/g) ?? [];
  let i = 0;
  const num = (v: unknown) => Number(v);
  function primary(): unknown {
    const t = toks[i++];
    if (t === '(') { const v = sum(); i++; return v; }
    if (t !== undefined && /^\d/.test(t)) return Number(t);
    if (t !== undefined && toks[i] === '(') {
      i++;
      const args = [sum()];
      while (toks[i] === ',') { i++; args.push(sum()); }
      i++;
      const f = t.toLowerCase();
      if (f === 'round') return Math.round(num(args[0]) * 10 ** num(args[1] ?? 0)) / 10 ** num(args[1] ?? 0);
      if (f === 'abs') return Math.abs(num(args[0]));
      if (f === 'upper') return String(args[0]).toUpperCase();
      if (f === 'lower') return String(args[0]).toLowerCase();
      return null;
    }
    return t === undefined ? null : row[t] ?? null;
  }
  function product(): unknown {
    let v = primary();
    while (toks[i] === '*' || toks[i] === '/') { const op = toks[i++]; const r = primary(); v = op === '*' ? num(v) * num(r) : num(v) / num(r); }
    return v;
  }
  function sum(): unknown {
    let v = product();
    while (toks[i] === '+' || toks[i] === '-') { const op = toks[i++]; const r = product(); v = op === '+' ? num(v) + num(r) : num(v) - num(r); }
    return v;
  }
  return sum();
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
  snap.metrics ??= [];
  for (const rows of [snap.logs, snap.traces, snap.metrics]) {
    for (const r of rows) {
      r.timestamp = shiftTime(String(r.timestamp), offset);
      if (typeof r.end_time === 'string') r.end_time = shiftTime(r.end_time, offset);
      for (const v of VARIANTS) if (typeof r[v] === 'string') r[v] = JSON.parse(r[v] as string);
      r._ms = msOf(String(r.timestamp));
    }
    rows.sort((a, b) => (b._ms as number) - (a._ms as number));
  }
  const data: Record<string, DemoRow[]> = { logs: snap.logs, traces: snap.traces, metrics: snap.metrics };
  const contentApi = createDemoContent({ sources, data, matcher }, () => Date.now());
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
      if ((path === '/api/search' || path === '/api/histogram' || path === '/api/facets' || path === '/api/values') && source) {
        const spec = specOf(p);
        if (spec.language === 'sql') throw new Error('The offline demo runs Lucene queries only; SQL mode needs a Doris cluster.');
        const match = matcher(source, spec);
        const rows = inWindow(p, data[source.name]!).filter(match);
        if (path === '/api/search') {
          const t0 = performance.now();
          const { sql, columns } = searchRowsSql(source, { ...spec, select: p.get('select') ?? undefined,
            orderBy: p.get('orderBy') ?? undefined, limit: Number(p.get('limit') ?? 200), offset: Number(p.get('offset') ?? 0) });
          const { extra } = selectColumns(source, p.get('select') || defaultSelectOf(source));
          const sorted = sortRows(rows, p.get('orderBy'));
          const offset = Number(p.get('offset') ?? 0);
          const page = sorted.slice(offset, offset + Number(p.get('limit') ?? 200)).map((r) => withExtras(source, strip(r), extra));
          const warnings = unknownFields(source, spec.where, snap.fields[source.name]!.map((f) => f.name))
            .map((u) => ({ kind: 'unknown_field', ...u }));
          return json(200, { rows: page, columns, sql, warnings, elapsedMs: Math.round(performance.now() - t0) });
        }
        if (path === '/api/histogram') {
          const from = Date.parse(p.get('from')!), to = Date.parse(p.get('to')!);
          const [step] = histogramStep(from, to, Number(p.get('buckets') ?? 120));
          const group = p.get('groupBy');
          const { sql } = searchHistogramSql(source, { ...spec, maxBuckets: Number(p.get('buckets') ?? 120), groupBy: group ?? undefined });
          const counts = new Map<string, number>();
          for (const r of rows) {
            const t = Math.floor((r._ms as number) / (step * 1000)) * step * 1000;
            const key = `${t}|${group ? fieldValue(source, r, group) ?? '' : ''}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const buckets = [...counts.entries()].map(([k, n]) => {
            const [t, g] = k.split('|');
            return { t: new Date(Number(t)).toISOString().replace('T', ' ').replace('Z', ''), ...(group ? { g } : {}), n };
          });
          return json(200, { stepSeconds: step, buckets, sql });
        }
        if (path === '/api/facets') {
          const names = p.get('fields')?.split(',').filter(Boolean) ?? defaultFacetFields(source, snap.fields[source.name]!).slice(0, 40);
          const sample = rows.slice(0, 20_000);
          const facets = names.map((field) => {
            const counts = new Map<string, number>();
            for (const r of sample) {
              const v = fieldValue(source, r, field);
              if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
            }
            return { field, values: [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([v, n]) => ({ v, n })) };
          });
          return json(200, { sampled: sample.length, facets, sql: facetsSql(source, spec, names) });
        }
        const field = p.get('field')!;
        const counts = new Map<string, number>();
        for (const r of rows) {
          const v = fieldValue(source, r, field);
          if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const values = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, Number(p.get('limit') ?? 10)).map(([v, n]) => ({ v, n }));
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
      const c = contentApi(method, path, p, (body ?? {}) as Record<string, unknown>);
      if (c) return json(c.status, c.body);
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
