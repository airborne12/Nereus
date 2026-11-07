// Client sessions: ingestion from the browser SDK, ingestion keys, and the Sessions pages' reads.
//
//   OPTIONS|POST /api/ingest/sessions   Authorization: Bearer <ingestion key>; CORS for any origin, no cookies
//   GET /api/sessions?where=&language=&filters=&from=&to=   sessions with a matching event
//   GET /api/sessions/<id>?from=&to=                         rows of one session (events and replay)
//   GET /api/sessions/by-trace/<trace id>?from=&to=          the session whose request started a trace
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
import { parseTime } from '../query/build.ts';
import { RateLimiter } from './limit.ts';
import { sessionForTraceSql, sessionRowsSql, sessionsListSql } from './query.ts';

export const INGEST_KEY_PREFIX = 'dsi';
// A full snapshot of a heavy page can be several MB; the SDK batches everything else under 1.5 MB.
const MAX_INGEST_BODY = 10 * 1024 * 1024;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

/** How long a key lookup is cached: a revoked key stops working within this time. */
const KEY_CACHE_MS = 10_000;

export class IngestKeys {
  private db: pg.Pool;
  private cache = new Map<string, { ok: boolean; until: number }>();
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
    this.forget();
  }

  /** True for a live ingestion key (cached briefly); marks it used at most once a minute. */
  async verify(token: string): Promise<boolean> {
    if (!token.startsWith(`${INGEST_KEY_PREFIX}_`)) return false;
    const now = Date.now();
    const hit = this.cache.get(token);
    if (hit && hit.until > now) return hit.ok;
    const r = await this.db.query(`SELECT id, last_used_at IS NULL OR last_used_at < now() - interval '1 minute' AS stale
      FROM ingest_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [tokenHash(token)]);
    const ok = Boolean(r.rows[0]);
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(token, { ok, until: now + KEY_CACHE_MS });
    if (ok && r.rows[0].stale) await this.db.query('UPDATE ingest_keys SET last_used_at = now() WHERE id = $1', [r.rows[0].id]);
    return ok;
  }

  /** Forget cached lookups (after a revoke in this process). */
  forget(): void {
    this.cache.clear();
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

export interface IngestLimits {
  /** Per ingestion key: a site's visitors share it. */
  perKey: RateLimiter;
  /** Per client address. */
  perClient: RateLimiter;
  /**
   * Trusted proxies in front of the server (0: none). Each appends the address it saw to
   * X-Forwarded-For, so the client is the entry this many places from the right; entries further
   * left are whatever the client sent and are never used.
   */
  proxyHops: number;
}

/** The address a request's per-client limit is counted against. */
export function clientAddress(xff: string | undefined, socketAddress: string | undefined, proxyHops: number): string {
  const entries = (xff ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (proxyHops > 0 && entries.length >= proxyHops) return entries[entries.length - proxyHops]!;
  return socketAddress ?? 'unknown';
}

/** INGEST_RATE_PER_KEY (100/s) and INGEST_RATE_PER_CLIENT (5/s), bursts 4x and 6x; TRUST_PROXY (trusted proxy hops). */
export function limitsFromEnv(env = process.env): IngestLimits {
  const perKey = Number(env.INGEST_RATE_PER_KEY ?? 100), perClient = Number(env.INGEST_RATE_PER_CLIENT ?? 5);
  const hops = Number(env.TRUST_PROXY ?? 0);
  if (!Number.isInteger(hops) || hops < 0) throw new Error('TRUST_PROXY must be the number of trusted proxies (0, 1, 2, ...)');
  return { perKey: new RateLimiter(perKey, perKey * 4), perClient: new RateLimiter(perClient, perClient * 6), proxyHops: hops };
}

export function sessionRoutes(o: { doris: Doris; keys: IngestKeys; source: Source; send: Send; now?: () => number; limits?: IngestLimits }) {
  const { doris, keys, source, send } = o;
  const limits = o.limits ?? limitsFromEnv();
  const limited = (res: ServerResponse, r: { ok: false; retryAfter: number }, what: string) =>
    send(res, 429, { error: `too many requests ${what}, slow down` }, { ...CORS, 'retry-after': String(r.retryAfter) });

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
      // The client's bucket first, so a script trying keys cannot make every attempt a database lookup.
      const fwd = req.headers['x-forwarded-for'];
      const client = clientAddress(Array.isArray(fwd) ? fwd.join(',') : fwd, req.socket.remoteAddress, limits.proxyHops);
      const c = limits.perClient.take(client);
      if (!c.ok) return limited(res, c, 'from this address');
      if (!(await keys.verify(token))) return send(res, 401, { error: 'a valid ingestion key is required' }, CORS);
      const k = limits.perKey.take(token);
      if (!k.ok) return limited(res, k, 'for this ingestion key');
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
    if ((m = /^\/api\/sessions\/by-trace\/([0-9a-f]{32})$/.exec(path)) && req.method === 'GET') {
      const from = parseTime(url.searchParams.get('from') ?? ''), to = parseTime(url.searchParams.get('to') ?? '');
      if (to <= from) throw new AuthError(400, 'to must be after from');
      const [row] = (await doris.query(sessionForTraceSql(source, m[1]!, from, to))) as Record<string, string>[];
      if (!row) {
        send(res, 200, { session: null });
        return true;
      }
      send(res, 200, { session: { sessionId: row.session_id, at: row.timestamp, started: row.started, ended: row.ended, user: row.user_email ?? row.user_name ?? null } });
      return true;
    }
    if ((m = /^\/api\/sessions\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const id = decodeURIComponent(m[1]!);
      if (!SESSION_ID.test(id)) throw new AuthError(400, 'bad session id');
      const from = parseTime(url.searchParams.get('from') ?? ''), to = parseTime(url.searchParams.get('to') ?? '');
      if (to <= from) throw new AuthError(400, 'to must be after from');
      const rows = (await doris.query(sessionRowsSql(source, id, from, to))) as Record<string, unknown>[];
      if (rows.length === 0) throw new AuthError(404, 'no such session in this time range');
      // Replay parts joined per chunk (seq and time: the parts of one chunk share both), in order.
      // seq comes from the browser, so a chunk that does not join into valid JSON is left out
      // rather than breaking the whole response; valid chunks are passed through as they are.
      const chunks = new Map<string, { seq: number; t: string; parts: string[] }>();
      const events: Record<string, unknown>[] = [];
      for (const r of rows) {
        if (r.kind === 'replay') {
          const k = `${Number(r.seq)}|${String(r.timestamp)}`;
          const c = chunks.get(k) ?? { seq: Number(r.seq), t: String(r.timestamp), parts: [] };
          c.parts[Number(r.part)] = String(r.payload);
          chunks.set(k, c);
        } else {
          events.push({ t: r.timestamp, type: r.event_type, url: r.url, message: r.message,
            attributes: r.attributes === null || r.attributes === undefined ? null : typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes });
        }
      }
      const last = rows.at(-1)!;
      const info = { sessionId: id, service: last.service_name, user: { id: last.user_id, email: last.user_email, name: last.user_name },
        userAgent: last.user_agent, started: rows[0]!.timestamp, ended: last.timestamp };
      const replay = [...chunks.values()].sort((a, b) => a.seq - b.seq || a.t.localeCompare(b.t)).map((c) => c.parts.join('')).filter((json) => {
        try {
          return Array.isArray(JSON.parse(json));
        } catch {
          return false;
        }
      });
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
