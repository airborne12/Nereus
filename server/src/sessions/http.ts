// Client sessions: ingestion from the browser SDK, ingestion keys, and the Sessions pages' reads.
//
//   OPTIONS|POST /api/ingest/sessions   Authorization: Bearer <ingestion key>; CORS for any origin, no cookies
//   GET /api/sessions?where=&language=&filters=&from=&to=   sessions with a matching event
//   GET /api/sessions/<id>?from=&to=                         rows of one session (events and replay)
//   GET /api/ingest-keys; POST {name}, DELETE /api/ingest-keys/<id>   (admins)

import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { readJson } from '../auth/http.ts';
import { newToken, tokenHash } from '../auth/secrets.ts';
import { AuthError, type User } from '../auth/store.ts';
import type { Doris } from '../db.ts';
import type { SearchSpec } from '../query/build.ts';
import type { Source } from '../query/source.ts';
import { IngestError, insertSql, SESSION_ID, sessionRows } from './ingest.ts';
import { sessionRowsSql, sessionsListSql } from './query.ts';

export const INGEST_KEY_PREFIX = 'dsi';
// A full snapshot of a heavy page can be several MB; the SDK batches everything else under 1.5 MB.
const MAX_INGEST_BODY = 10 * 1024 * 1024;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

export class IngestKeys {
  private db: pg.Pool;
  constructor(db: pg.Pool) {
    this.db = db;
  }

  async list() {
    const r = await this.db.query('SELECT k.*, u.name AS created_by_name FROM ingest_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.id DESC');
    return r.rows.map((x) => ({ id: Number(x.id), name: x.name, prefix: x.prefix, createdBy: x.created_by_name ?? null,
      createdAt: iso(x.created_at), lastUsedAt: iso(x.last_used_at), revoked: x.revoked_at !== null }));
  }

  /** Returns the key itself once; only its hash is kept. */
  async create(userId: number, name: unknown) {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (clean.length === 0 || clean.length > 100) throw new AuthError(400, 'name must have 1 to 100 characters');
    const key = newToken(INGEST_KEY_PREFIX);
    const r = await this.db.query('INSERT INTO ingest_keys (name, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [clean, key.slice(0, 12), tokenHash(key), userId]);
    return { key, id: Number(r.rows[0].id) };
  }

  async revoke(id: number) {
    const r = await this.db.query('UPDATE ingest_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1', [id]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such ingestion key');
  }

  /** True for a live ingestion key; marks it used at most once a minute. */
  async verify(token: string): Promise<boolean> {
    if (!token.startsWith(`${INGEST_KEY_PREFIX}_`)) return false;
    const r = await this.db.query(`SELECT id, last_used_at IS NULL OR last_used_at < now() - interval '1 minute' AS stale
      FROM ingest_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [tokenHash(token)]);
    if (!r.rows[0]) return false;
    if (r.rows[0].stale) await this.db.query('UPDATE ingest_keys SET last_used_at = now() WHERE id = $1', [r.rows[0].id]);
    return true;
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  // text/plain too: a page can then send without a CORS preflight (sendBeacon, keepalive fetch).
  if (!/^(application\/json|text\/plain)\b/i.test(type)) throw new IngestError(415, 'body must be JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_INGEST_BODY) throw new IngestError(413, 'body is larger than 10 MB');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new IngestError(400, 'body is not a JSON object');
  }
}

type Send = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;

export function sessionRoutes(o: { doris: Doris; keys: IngestKeys; source: Source; send: Send; now?: () => number }) {
  const { doris, keys, source, send } = o;

  /** The ingestion endpoint: no session cookie is read, only the ingestion key. */
  async function ingest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return void res.end();
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, CORS);
    try {
      // sendBeacon cannot set headers, so the key may also come as ?key=.
      const h = req.headers.authorization ?? '';
      const token = /^Bearer\s+(\S+)$/i.exec(h)?.[1] ?? new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? '';
      if (!(await keys.verify(token))) return send(res, 401, { error: 'a valid ingestion key is required' }, CORS);
      const rows = sessionRows(await readBody(req), (o.now ?? Date.now)());
      for (const sql of insertSql(source.table, rows)) await doris.query(sql);
      send(res, 200, { rows: rows.length }, CORS);
    } catch (e) {
      if (e instanceof IngestError) return send(res, e.status, { error: e.message }, CORS);
      throw e;
    }
  }

  /** Signed-in routes; returns false when the path is not one of them. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, user: User, spec: () => SearchSpec): Promise<boolean> {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path === '/api/sessions' && req.method === 'GET') {
      const sql = sessionsListSql(source, spec());
      send(res, 200, { sessions: await doris.query(sql), sql });
      return true;
    }
    if ((m = /^\/api\/sessions\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const id = decodeURIComponent(m[1]!);
      if (!SESSION_ID.test(id)) throw new AuthError(400, 'bad session id');
      const from = Date.parse(url.searchParams.get('from') ?? ''), to = Date.parse(url.searchParams.get('to') ?? '');
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new AuthError(400, 'from and to are required');
      const rows = (await doris.query(sessionRowsSql(source, id, from, to))) as Record<string, unknown>[];
      if (rows.length === 0) throw new AuthError(404, 'no such session in this time range');
      // Replay parts joined per chunk, in seq order. The JSON is passed through, not re-parsed.
      const chunks = new Map<number, string[]>();
      const events: Record<string, unknown>[] = [];
      for (const r of rows) {
        if (r.kind === 'replay') {
          const seq = Number(r.seq);
          const parts = chunks.get(seq) ?? [];
          parts[Number(r.part)] = String(r.payload);
          chunks.set(seq, parts);
        } else {
          events.push({ t: r.timestamp, type: r.event_type, url: r.url, message: r.message,
            attributes: r.attributes === null || r.attributes === undefined ? null : typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes });
        }
      }
      const last = rows.at(-1)!;
      const info = { sessionId: id, service: last.service_name, user: { id: last.user_id, email: last.user_email, name: last.user_name },
        userAgent: last.user_agent, started: rows[0]!.timestamp, ended: last.timestamp };
      const replay = [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, parts]) => parts.join(''));
      const body = `{"session":${JSON.stringify(info)},"events":${JSON.stringify(events)},"replay":[${replay.join(',')}]}`;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return true;
    }
    if (path.startsWith('/api/ingest-keys')) {
      if (user.role !== 'admin') throw new AuthError(403, 'only admins manage ingestion keys');
      if (path === '/api/ingest-keys' && req.method === 'GET') {
        send(res, 200, { keys: await keys.list() });
        return true;
      }
      if (path === '/api/ingest-keys' && req.method === 'POST') {
        send(res, 201, await keys.create(user.id, (await readJson(req)).name));
        return true;
      }
      if ((m = /^\/api\/ingest-keys\/(\d+)$/.exec(path)) && req.method === 'DELETE') {
        await keys.revoke(Number(m[1]));
        send(res, 200, { ok: true });
        return true;
      }
    }
    return false;
  }

  return { ingest, handle };
}
