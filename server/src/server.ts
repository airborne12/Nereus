// DorisStack API service: search, histogram, traces, fields; users, sessions and API keys.
//
// Every /api/* path except /api/auth/* needs a session cookie or `Authorization: Bearer <key>`.
//
//   GET /healthz
//   GET  /api/auth/status | POST /api/auth/setup | /api/auth/login | /api/auth/logout
//   GET|POST /api/keys, DELETE /api/keys/<id>
//   GET|POST /api/users, POST /api/users/<id>/disabled        (admins)
//   GET /api/search?source=logs|traces&q=&from=&to=&limit=&columns=a,b
//   GET /api/histogram?source=&q=&from=&to=&buckets=&groupBy=
//   GET /api/trace/<trace id>?from=&to=
//   GET /api/fields?source=                  search bar fields (cached for a minute)
//   GET /api/values?source=&field=&q=&from=&to=&limit=   top values of a field
//
// Times are UTC (ISO 8601 or "YYYY-MM-DD HH:MM:SS"). Query errors answer 400 with a message.

import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { QuerySyntaxError } from './query/ast.ts';
import { fieldsFromDescribe, histogramSql, rowsSql, traceSql, valuesSql, type Field } from './query/build.ts';
import { CompileError, unknownFields } from './query/compile.ts';
import { logsSource, tracesSource, type Source } from './query/source.ts';
import { Doris, configFromEnv } from './db.ts';
import { type AuthContext, authRoutes, authenticate } from './auth/http.ts';
import { AuthError, AuthStore } from './auth/store.ts';
import { metaPoolFromEnv, migrate } from './meta.ts';

class BadRequest extends Error {}

export interface AppOptions {
  doris: Doris;
  db: string;
  auth: AuthContext;
  /** Directory of the built web UI (web/dist); other paths than /api are served from it. */
  webDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
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
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
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

export function createApp({ doris, db, auth, webDir }: AppOptions): Server {
  const account = authRoutes(auth, send);
  const sources: Record<string, Source> = { logs: logsSource(db), traces: tracesSource(db) };
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
    if (path.startsWith('/api/auth/')) {
      if (await account.handlePublic(req, res, path)) return;
      return send(res, 404, { error: 'not found' });
    }
    const user = await authenticate(auth, req);
    if (!user) return send(res, 401, { error: 'login required' });
    if (await account.handleAccount(req, res, path, user)) return;
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    if (url.pathname === '/api/search') {
      const source = sourceParam(url);
      const columns = param(url, 'columns', false)?.split(',').filter(Boolean);
      const sql = rowsSql(source, {
        query: param(url, 'q', false) ?? '', from: param(url, 'from')!, to: param(url, 'to')!,
        limit: intParam(url, 'limit'), columns,
      });
      const started = performance.now();
      const [rows, known] = await Promise.all([doris.query(sql), fields(source)]);
      // Fields the data has never had: the query is valid but they match nothing.
      const warnings = unknownFields(source, param(url, 'q', false) ?? '', known.map((f) => f.name))
        .map((u) => ({ kind: 'unknown_field', ...u }));
      return send(res, 200, { rows, warnings, elapsedMs: Math.round(performance.now() - started) });
    }
    if (url.pathname === '/api/histogram') {
      const source = sourceParam(url);
      const { sql, stepSeconds } = histogramSql(source, {
        query: param(url, 'q', false) ?? '', from: param(url, 'from')!, to: param(url, 'to')!,
        maxBuckets: intParam(url, 'buckets'), groupBy: param(url, 'groupBy', false),
      });
      const rows = await doris.query(sql);
      return send(res, 200, { stepSeconds, buckets: rows });
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
  createApp({ doris, db: process.env.DORIS_DB ?? 'otel', auth, webDir }).listen(port, () => {
    console.log(`dorisstack server listening on :${port}`);
  });
}
