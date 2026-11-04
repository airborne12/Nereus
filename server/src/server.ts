// DorisStack API service (M1 skeleton): search rows, histogram, trace lookup.
//
//   GET /healthz
//   GET /api/search?source=logs|traces&q=&from=&to=&limit=&columns=a,b
//   GET /api/histogram?source=&q=&from=&to=&buckets=&groupBy=
//   GET /api/trace/<trace id>?from=&to=
//
// Times are UTC (ISO 8601 or "YYYY-MM-DD HH:MM:SS"). Query errors answer 400 with a message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { QuerySyntaxError } from './query/ast.ts';
import { histogramSql, rowsSql, traceSql } from './query/build.ts';
import { CompileError } from './query/compile.ts';
import { logsSource, tracesSource, type Source } from './query/source.ts';
import { Doris, configFromEnv } from './db.ts';

class BadRequest extends Error {}

export interface AppOptions {
  doris: Doris;
  db: string;
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

export function createApp({ doris, db }: AppOptions): Server {
  const sources: Record<string, Source> = { logs: logsSource(db), traces: tracesSource(db) };
  const sourceParam = (url: URL): Source => {
    const name = param(url, 'source')!;
    const s = sources[name];
    if (!s) throw new BadRequest(`unknown source '${name}'`);
    return s;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    if (url.pathname === '/healthz') {
      await doris.query('SELECT 1');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/search') {
      const source = sourceParam(url);
      const columns = param(url, 'columns', false)?.split(',').filter(Boolean);
      const sql = rowsSql(source, {
        query: param(url, 'q', false) ?? '', from: param(url, 'from')!, to: param(url, 'to')!,
        limit: intParam(url, 'limit'), columns,
      });
      const started = performance.now();
      const rows = await doris.query(sql);
      return send(res, 200, { rows, elapsedMs: Math.round(performance.now() - started) });
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
  const port = Number(process.env.PORT ?? 8090);
  createApp({ doris, db: process.env.DORIS_DB ?? 'otel' }).listen(port, () => {
    console.log(`dorisstack server listening on :${port}`);
  });
}
