// Offline demo: saved searches, favorites, webhooks, alerts, dashboards and charts, kept in memory
// and computed over the snapshot. Starts with example content so every page has something.

import { chartSql, type ChartSpec, histogramStep, type SearchSpec } from '../../../server/src/query/build.ts';
import type { Source } from '../../../server/src/query/source.ts';
import { type DemoRow, fieldValue } from './evaluate.ts';

type J = Record<string, any>;

export interface DemoContext {
  sources: Record<string, Source>;
  data: Record<string, DemoRow[]>;
  matcher: (source: Source, spec: SearchSpec) => (r: DemoRow) => boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();
const doris = (ms: number) => iso(ms).replace('T', ' ').replace('Z', '');

function aggregate(source: Source, rows: DemoRow[], s: { agg: string; field?: string }): number | null {
  if (s.agg === 'count') return rows.length;
  if (s.agg === 'count_distinct') return new Set(rows.map((r) => fieldValue(source, r, s.field!)).filter((v) => v !== null)).size;
  const vals = rows.map((r) => Number(fieldValue(source, r, s.field!))).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  if (s.agg === 'sum') return vals.reduce((a, b) => a + b, 0);
  if (s.agg === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
  if (s.agg === 'min') return Math.min(...vals);
  if (s.agg === 'max') return Math.max(...vals);
  const q = Number(s.agg.slice(1)) / 100;
  const sorted = vals.sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function createDemoContent(ctx: DemoContext, now: () => number) {
  const rowsFor = (source: Source, spec: SearchSpec) => {
    const from = Date.parse(spec.from), to = Date.parse(spec.to);
    const match = ctx.matcher(source, spec);
    return ctx.data[source.name]!.filter((r) => (r._ms as number) >= from && (r._ms as number) < to && match(r));
  };

  function chart(def: J): J {
    const source = ctx.sources[def.source];
    if (!source) throw new Error(`unknown source '${def.source}'`);
    const spec = { ...def, where: def.where ?? '', language: def.language ?? 'lucene', filters: def.filters ?? [] } as ChartSpec;
    if (spec.language === 'sql') throw new Error('The offline demo runs Lucene queries only; SQL mode needs a Doris cluster.');
    const { sql, stepSeconds } = chartSql(source, spec);
    const rows = rowsFor(source, spec);
    const groupOf = (r: DemoRow) => (def.groupBy ? fieldValue(source, r, def.groupBy) : null);
    const values = (rs: DemoRow[]) => Object.fromEntries(def.series.map((s: J, i: number) => [`v${i}`, aggregate(source, rs, s as { agg: string; field?: string })]));
    if (def.display === 'number') return { rows: [values(rows)], stepSeconds: null, sql };
    const groups = new Map<string, DemoRow[]>();
    const key = (r: DemoRow) => {
      if (def.display === 'table') return JSON.stringify([groupOf(r)]);
      const [step] = histogramStep(Date.parse(def.from), Date.parse(def.to), def.maxBuckets ?? 60);
      return JSON.stringify([Math.floor((r._ms as number) / (step * 1000)) * step * 1000, groupOf(r)]);
    };
    for (const r of rows) {
      const k = key(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    let out = [...groups.entries()].map(([k, rs]) => {
      const parts = JSON.parse(k);
      return def.display === 'table' ? { g: parts[0], ...values(rs) } : { t: doris(parts[0]), ...(def.groupBy ? { g: parts[1] } : {}), ...values(rs) };
    });
    if (def.display === 'table') out = out.sort((a: J, b: J) => Number(b.v0) - Number(a.v0)).slice(0, 100);
    else out.sort((a: J, b: J) => String(a.t).localeCompare(String(b.t)));
    return { rows: out, stepSeconds, sql };
  }

  // ---------------- state, with examples
  let nextId = 100;
  const t0 = iso(now() - 3 * 86400_000);
  const searches: J[] = [
    { id: 1, name: 'Checkout errors', source: 'logs', where: 'level:error', language: 'lucene',
      filters: [{ field: 'service', values: ['checkout', 'payment'] }], select: '', orderBy: '', tags: ['checkout', 'oncall'],
      createdBy: 'Demo', createdAt: t0, updatedAt: t0 },
    { id: 2, name: 'Slow frontend requests', source: 'traces', where: 'service:frontend duration:>20ms', language: 'lucene',
      filters: [], select: '', orderBy: 'duration DESC', tags: ['latency'], createdBy: 'Demo', createdAt: t0, updatedAt: t0 },
  ];
  const favorites = new Set(['search:1', 'dashboard:1']);
  const webhooks: J[] = [{ id: 1, name: '#oncall (demo: nothing is sent)', url: 'https://hooks.slack.com/services/T000/B000/demo', createdAt: t0 }];
  const alerts: J[] = [];
  const history = new Map<number, J[]>();
  const tile = (title: string, w: number, chart: J) => ({ id: crypto.randomUUID(), title, w, chart: { where: '', language: 'lucene', filters: [], ...chart } });
  const dashboards: J[] = [{
    id: 1, name: 'Service health', tags: ['ops'], createdBy: 'Demo', updatedAt: t0, tiles: [
      tile('Spans by service', 8, { source: 'traces', display: 'line', series: [{ agg: 'count' }], groupBy: 'service' }),
      tile('Error spans', 4, { source: 'traces', display: 'number', series: [{ agg: 'count' }], where: 'status:error' }),
      tile('p99 latency by service (µs)', 6, { source: 'traces', display: 'line', series: [{ agg: 'p99', field: 'duration' }], groupBy: 'service' }),
      tile('Logs by level', 6, { source: 'logs', display: 'table', series: [{ agg: 'count' }], groupBy: 'level' }),
      tile('CPU utilization', 12, { source: 'metrics', display: 'line', series: [{ agg: 'avg', field: 'value' }], where: 'metric:process.cpu.utilization', groupBy: 'service' }),
    ],
  }];

  /** One check of an alert over the snapshot, like AlertRunner does against Doris. */
  function check(a: J) {
    const s = searches.find((x) => x.id === a.savedSearchId)!;
    const to = now(), from = to - a.intervalSeconds * 1000;
    const value = rowsFor(ctx.sources[s.source]!, { ...s, from: iso(from), to: iso(to) } as SearchSpec).length;
    const state = (a.thresholdType === 'above' ? value > a.threshold : value < a.threshold) ? 'ALERT' : 'OK';
    const notified = state !== a.state && (state === 'ALERT' || a.state === 'ALERT');
    Object.assign(a, { state, lastValue: value, lastCheckedAt: iso(to) });
    history.set(a.id, [{ checkedAt: iso(to), value, state, error: notified ? 'demo: the webhook is not called' : null, notified: false }, ...(history.get(a.id) ?? [])]);
  }
  function addAlert(body: J): J {
    const s = searches.find((x) => x.id === Number(body.savedSearchId));
    const w = webhooks.find((x) => x.id === Number(body.webhookId));
    if (!s || !w) throw new Error('no such saved search or webhook');
    const a: J = { id: nextId++, savedSearchId: s.id, savedSearchName: s.name, webhookId: w.id, webhookName: w.name,
      thresholdType: body.thresholdType, threshold: Number(body.threshold), intervalSeconds: Number(body.intervalSeconds),
      state: 'OK', lastCheckedAt: null, lastValue: null, silencedUntil: null, createdAt: iso(now()) };
    alerts.push(a);
    check(a);
    return a;
  }
  addAlert({ savedSearchId: 1, webhookId: 1, thresholdType: 'above', threshold: 3, intervalSeconds: 900 });

  const alertState = (id: number) => {
    const as = alerts.filter((a) => a.savedSearchId === id);
    if (as.length === 0) return null;
    return as.some((a) => a.state === 'ALERT') ? 'ALERT' : as.some((a) => a.state === 'ERROR') ? 'ERROR' : 'OK';
  };
  const viewSearch = (s: J) => ({ ...s, favorite: favorites.has(`search:${s.id}`), alertState: alertState(s.id) });
  const viewDash = (d: J) => ({ ...d, favorite: favorites.has(`dashboard:${d.id}`) });

  return function handle(method: string, path: string, params: URLSearchParams, body: J): { status: number; body: unknown } | null {
    let m: RegExpExecArray | null;
    if (path === '/api/chart' && method === 'POST') return { status: 200, body: chart(body) };
    for (const [base, kind, list] of [['/api/saved-searches', 'search', searches], ['/api/dashboards', 'dashboard', dashboards]] as const) {
      const view = kind === 'search' ? viewSearch : viewDash;
      if (path === base && method === 'GET') return { status: 200, body: { items: [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(view) } };
      if (path === base && method === 'POST') {
        const item: J = { ...body, id: nextId++, createdBy: 'Demo', createdAt: iso(now()), updatedAt: iso(now()), tags: body.tags ?? [] };
        if (kind === 'dashboard') item.tiles = (body.tiles ?? []).map((t: J) => ({ ...t, id: t.id || crypto.randomUUID() }));
        list.push(item);
        return { status: 201, body: view(item) };
      }
      if ((m = new RegExp(`^${base}/(\\d+)$`).exec(path))) {
        const i = list.findIndex((x) => x.id === Number(m![1]));
        if (i < 0) return { status: 404, body: { error: `no such ${kind === 'search' ? 'saved search' : 'dashboard'}` } };
        if (method === 'GET') return { status: 200, body: view(list[i]!) };
        if (method === 'PUT') {
          const { favorite: _f, alertState: _a, ...rest } = body;
          list[i] = { ...list[i], ...rest, id: list[i]!.id, updatedAt: iso(now()) };
          return { status: 200, body: view(list[i]!) };
        }
        if (method === 'DELETE') {
          list.splice(i, 1);
          return { status: 200, body: { ok: true } };
        }
      }
      if ((m = new RegExp(`^${base}/(\\d+)/favorite$`).exec(path))) {
        if (body.on) favorites.add(`${kind}:${m[1]}`);
        else favorites.delete(`${kind}:${m[1]}`);
        return { status: 200, body: { ok: true } };
      }
    }
    if (path === '/api/webhooks' && method === 'GET') return { status: 200, body: { items: webhooks } };
    if (path === '/api/webhooks' && method === 'POST') {
      const w = { id: nextId++, name: body.name, url: body.url, createdAt: iso(now()) };
      webhooks.push(w);
      return { status: 201, body: w };
    }
    if ((m = /^\/api\/webhooks\/(\d+)\/test$/.exec(path))) return { status: 200, body: { ok: true } };
    if ((m = /^\/api\/webhooks\/(\d+)$/.exec(path)) && method === 'DELETE') {
      if (alerts.some((a) => a.webhookId === Number(m![1]))) return { status: 409, body: { error: 'alerts still use this webhook' } };
      webhooks.splice(webhooks.findIndex((w) => w.id === Number(m![1])), 1);
      return { status: 200, body: { ok: true } };
    }
    if (path === '/api/alerts' && method === 'GET') {
      const s = params.get('savedSearchId');
      return { status: 200, body: { items: alerts.filter((a) => s === null || a.savedSearchId === Number(s)) } };
    }
    if (path === '/api/alerts' && method === 'POST') return { status: 201, body: addAlert(body) };
    if ((m = /^\/api\/alerts\/(\d+)$/.exec(path)) && method === 'DELETE') {
      alerts.splice(alerts.findIndex((a) => a.id === Number(m![1])), 1);
      return { status: 200, body: { ok: true } };
    }
    if ((m = /^\/api\/alerts\/(\d+)\/silence$/.exec(path))) {
      const a = alerts.find((x) => x.id === Number(m![1]));
      if (a) a.silencedUntil = Number(body.minutes) > 0 ? iso(now() + Number(body.minutes) * 60_000) : null;
      return { status: 200, body: { ok: true } };
    }
    if ((m = /^\/api\/alerts\/(\d+)\/history$/.exec(path))) return { status: 200, body: { items: history.get(Number(m[1])) ?? [] } };
    return null;
  };
}
