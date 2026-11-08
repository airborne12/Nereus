// Nereus API service: search, histogram, traces, fields; users, sessions and API keys.
//
// Every /api/* path except /api/auth/* needs a session cookie or `Authorization: Bearer <key>`.
//
//   GET /healthz
//   GET  /api/auth/status | POST /api/auth/setup | /api/auth/login | /api/auth/logout
//   GET|POST /api/keys, DELETE /api/keys/<id>
//   GET|POST /api/users, POST /api/users/<id>/disabled        (admins)
//   saved searches, dashboards, webhooks, alerts: see content/http.ts
//   POST /api/chart {source, display, series, where, language, filters, groupBy, from, to}   chart data
//   GET /api/service-map?where=&language=&filters=&from=&to=     calls between services
//   GET /api/heatmap?where=&language=&filters=&from=&to=&buckets= trace durations over time
//   GET /api/search?source=logs|traces&where=&language=lucene|sql&filters=<json>&select=&orderBy=
//                  &from=&to=&limit=&offset=      (q= is the same as where= with lucene)
//   GET /api/histogram?source=&where=&language=&filters=&from=&to=&buckets=&groupBy=&groups=
//   GET /api/facets?source=&where=&language=&filters=&from=&to=&fields=a,b   filter panel values
//   GET /api/trace/<trace id>?from=&to=
//   GET /api/fields?source=                  search bar fields (cached for a minute)
//   GET /api/values?source=&field=&q=&from=&to=&limit=   top values of a field
//
// Times are UTC (ISO 8601 or "YYYY-MM-DD HH:MM:SS"). Query errors answer 400 with a message.

import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { QuerySyntaxError } from './query/ast.ts';
import { AlertRunner } from './content/alerts.ts';
import { contentRoutes } from './content/http.ts';
import { ContentStore } from './content/store.ts';
import { readJson } from './auth/http.ts';
import {
  type ChartSpec, chartSql, defaultFacetFields, facetsSql, heatmapSql, serviceMapSql, fieldsFromDescribe, type Filter, searchHistogramSql, searchRowsSql, type SearchSpec,
  traceSql, valuesSql, type Field,
} from './query/build.ts';
import { CompileError, unknownFields } from './query/compile.ts';
import { logsSource, metricsSource, sessionsSource, tracesSource, type Source } from './query/source.ts';
import { Doris, configFromEnv } from './db.ts';
import { type AuthContext, authRoutes, authenticate } from './auth/http.ts';
import { type IngestLimits, IngestKeys, sessionRoutes } from './sessions/http.ts';
import { AuthError, AuthStore } from './auth/store.ts';
import { metaPoolFromEnv, migrate } from './meta.ts';

class BadRequest extends Error {}

export interface AppOptions {
  doris: Doris;
  db: string;
  auth: AuthContext;
  content: ContentStore;
  /** Ingestion keys of the browser SDK (POST /api/ingest/sessions). */
  ingestKeys: IngestKeys;
  /** Ingestion rate limits; from the environment by default (limitsFromEnv). */
  ingestLimits?: IngestLimits;
  /** For webhook tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Directory of the built web UI (web/dist); other paths than /api are served from it. */
  webDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

/** Serve a file of the built UI; unknown paths get index.html so client routes reload. */
async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'malformed path' });
  }
  let file = resolve(join(base, normalize(decoded)));
  if (file !== base && !file.startsWith(base + sep)) return send(res, 403, { error: 'forbidden' });
  const isFile = await stat(file).then((s) => s.isFile(), () => false);
  if (!isFile) file = join(base, 'index.html');
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // Hashed assets never change; index.html and the SDK (a fixed URL other sites load) are revalidated.
    'cache-control': file.endsWith('index.html') || pathname.startsWith('/sdk/') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

function param(url: URL, name: string, required = true): string | undefined {
  const v = url.searchParams.get(name);
  if (v === null && required) throw new BadRequest(`missing parameter '${name}'`);
  return v ?? undefined;
}

function intParam(url: URL, name: string): number | undefined {
  const v = param(url, name, false);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new BadRequest(`'${name}' must be a positive integer`);
  return Number(v);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store', ...headers,
  });
  res.end(json);
}

export function sourcesFor(db: string): Record<string, Source> {
  return { logs: logsSource(db), traces: tracesSource(db), metrics: metricsSource(db) };
}

export function createApp({ doris, db, auth, content, ingestKeys, ingestLimits, fetchImpl, webDir }: AppOptions): Server {
  const account = authRoutes(auth, send);
  const sessions = sessionRoutes({ doris, keys: ingestKeys, source: sessionsSource(db), send, limits: ingestLimits });
  const contentApi = contentRoutes(content, send, fetchImpl);
  const sources = sourcesFor(db);
  const sourceParam = (url: URL): Source => {
    const name = param(url, 'source')!;
    const s = sources[name];
    if (!s) throw new BadRequest(`unknown source '${name}'`);
    return s;
  };

  const fieldCache = new Map<string, { at: number; fields: Field[] }>();
  async function fields(source: Source): Promise<Field[]> {
    const hit = fieldCache.get(source.name);
    if (hit && Date.now() - hit.at < 60_000) return hit.fields;
    const rows = (await doris.query(`DESC ${source.table}`)) as { Field: string; Type: string }[];
    const f = fieldsFromDescribe(source, rows);
    fieldCache.set(source.name, { at: Date.now(), fields: f });
    return f;
  }

  function searchSpec(url: URL): SearchSpec {
    const language = param(url, 'language', false) ?? 'lucene';
    if (language !== 'lucene' && language !== 'sql') throw new BadRequest("language must be 'lucene' or 'sql'");
    let filters: Filter[] = [];
    const raw = param(url, 'filters', false);
    if (raw) {
      try {
        filters = JSON.parse(raw);
      } catch {
        throw new BadRequest('filters must be JSON');
      }
      if (!Array.isArray(filters) || !filters.every((f) => typeof f?.field === 'string' && Array.isArray(f.values))) {
        throw new BadRequest('filters must be a list of {field, values, exclude}');
      }
    }
    return {
      where: param(url, 'where', false) ?? param(url, 'q', false) ?? '', language, filters,
      from: param(url, 'from')!, to: param(url, 'to')!,
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/healthz') {
      await doris.query('SELECT 1');
      return send(res, 200, { ok: true });
    }
    if (!path.startsWith('/api/')) {
      if (req.method !== 'GET' || !webDir) return send(res, 404, { error: 'not found' });
      return serveStatic(webDir, path, res);
    }
    // Browser SDK ingestion: authorised by an ingestion key only, never by a session cookie.
    if (path === '/api/ingest/sessions') return sessions.ingest(req, res);
    if (path.startsWith('/api/auth/')) {
      if (await account.handlePublic(req, res, path)) return;
      return send(res, 404, { error: 'not found' });
    }
    const user = await authenticate(auth, req);
    if (!user) return send(res, 401, { error: 'login required' });
    if (await account.handleAccount(req, res, path, user)) return;
    if (await contentApi(req, res, url, user)) return;
    if (await sessions.handle(req, res, url, user, () => searchSpec(url))) return;
    if (path === '/api/chart' && req.method === 'POST') {
      const b = await readJson(req);
      const source = sources[String(b.source)];
      if (!source) throw new BadRequest(`unknown source '${String(b.source)}'`);
      const spec = { ...b, where: String(b.where ?? ''), from: String(b.from), to: String(b.to) } as unknown as ChartSpec;
      const { sql, stepSeconds } = chartSql(source, spec);
      const started = performance.now();
      const rows = await doris.query(sql);
      return send(res, 200, { rows, stepSeconds, sql, elapsedMs: Math.round(performance.now() - started) });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    if (url.pathname === '/api/search') {
      const source = sourceParam(url);
      const spec = searchSpec(url);
      const { sql, columns } = searchRowsSql(source, {
        ...spec, select: param(url, 'select', false), orderBy: param(url, 'orderBy', false),
        limit: intParam(url, 'limit'), offset: intParam(url, 'offset'),
      });
      const started = performance.now();
      const [rows, known] = await Promise.all([doris.query(sql), fields(source)]);
      // Fields the data has never had: the query is valid but they match nothing.
      const warnings = spec.language === 'sql' ? [] : unknownFields(source, spec.where, known.map((f) => f.name))
        .map((u) => ({ kind: 'unknown_field', ...u }));
      return send(res, 200, { rows, columns, sql, warnings, elapsedMs: Math.round(performance.now() - started) });
    }
    if (url.pathname === '/api/histogram') {
      const source = sourceParam(url);
      const { sql, stepSeconds } = searchHistogramSql(source, {
        ...searchSpec(url), maxBuckets: intParam(url, 'buckets'), groupBy: param(url, 'groupBy', false), maxGroups: intParam(url, 'groups'),
      });
      const rows = await doris.query(sql);
      return send(res, 200, { stepSeconds, buckets: rows, sql });
    }
    if (url.pathname === '/api/facets') {
      const source = sourceParam(url);
      const asked = param(url, 'fields', false)?.split(',').filter(Boolean);
      const names = asked ?? defaultFacetFields(source, await fields(source)).slice(0, 40);
      const value = param(url, 'value', false);
      if (value !== undefined && names.length !== 1) throw new CompileError('value search requires one facet field');
      const spec = searchSpec(url);
      // A field with a filter lists its values without its own filter, so more of them can be
      // picked (values of one field are ORed); every other filter still applies. Unfiltered
      // fields share one query with all filters.
      const filtered = names.filter((n) => (spec.filters ?? []).some((f) => f.field === n));
      const groups = [
        { fields: names.filter((n) => !filtered.includes(n)), spec },
        ...filtered.map((n) => ({ fields: [n], spec: { ...spec, filters: (spec.filters ?? []).filter((f) => f.field !== n) } })),
      ].filter((g) => g.fields.length > 0);
      const results = await Promise.all(groups.map(async (g) => {
        const sql = facetsSql(source, g.spec, g.fields, value);
        return { g, sql, row: (await doris.query(sql))[0] };
      }));
      const byField = new Map<string, { field: string; sampled: number; values: { v: string; n: number }[] }>();
      for (const { g, row } of results) {
        g.fields.forEach((field, i) => {
          const top = row?.[`f${i}`] ? (JSON.parse(String(row[`f${i}`])) as Record<string, number>) : {};
          byField.set(field, { field, sampled: Number(row?.__sampled ?? 0), values: Object.entries(top).map(([v, n]) => ({ v, n: Number(n) })) });
        });
      }
      const base = results.find((r) => r.g.spec === spec);
      return send(res, 200, {
        sampled: base ? Number(base.row?.__sampled ?? 0) : (byField.get(names[0]!)?.sampled ?? 0),
        facets: names.map((n) => byField.get(n)!), sql: results.map((r) => r.sql).join(';\n'),
      });
    }
    if (url.pathname === '/api/fields') {
      return send(res, 200, { fields: await fields(sourceParam(url)) });
    }
    if (url.pathname === '/api/values') {
      const sql = valuesSql(sourceParam(url), {
        field: param(url, 'field')!, query: param(url, 'q', false) ?? '',
        from: param(url, 'from')!, to: param(url, 'to')!, limit: intParam(url, 'limit'),
      });
      return send(res, 200, { values: await doris.query(sql) });
    }
    if (url.pathname === '/api/service-map') {
      const { edges, nodes } = serviceMapSql(sources.traces!, searchSpec(url));
      const [e, n] = await Promise.all([doris.query(edges), doris.query(nodes)]);
      return send(res, 200, { edges: e, nodes: n, sql: { edges, nodes } });
    }
    if (url.pathname === '/api/heatmap') {
      const { sql, stepSeconds } = heatmapSql(sources.traces!, { ...searchSpec(url), maxBuckets: intParam(url, 'buckets') });
      return send(res, 200, { cells: await doris.query(sql), stepSeconds, sql });
    }
    const trace = /^\/api\/trace\/([^/]+)$/.exec(url.pathname);
    if (trace) {
      const sql = traceSql(sources.traces!, decodeURIComponent(trace[1]!), {
        from: param(url, 'from')!, to: param(url, 'to')!,
      });
      return send(res, 200, { spans: await doris.query(sql) });
    }
    return send(res, 404, { error: 'not found' });
  }

  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof AuthError) return send(res, e.status, { error: e.message });
      if (e instanceof BadRequest || e instanceof QuerySyntaxError || e instanceof CompileError) {
        return send(res, 400, { error: e.message });
      }
      console.error(e);
      send(res, 500, { error: 'query failed', detail: e instanceof Error ? e.message : String(e) });
    });
  });
}

if (import.meta.main) {
  const doris = new Doris(configFromEnv());
  const meta = metaPoolFromEnv();
  const applied = await migrate(meta);
  if (applied.length) console.log(`applied migrations: ${applied.join(', ')}`);
  const port = Number(process.env.PORT ?? 8090);
  const webDir = process.env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname;
  const auth = { store: new AuthStore(meta), secureCookie: process.env.COOKIE_SECURE === '1' };
  const content = new ContentStore(meta);
  const db = process.env.DORIS_DB ?? 'otel';
  new AlertRunner({ store: content, doris, sources: sourcesFor(db), baseUrl: process.env.PUBLIC_URL ?? null }).start();
  createApp({ doris, db, auth, content, ingestKeys: new IngestKeys(meta), webDir }).listen(port, () => {
    console.log(`nereus server listening on :${port}`);
  });
}
