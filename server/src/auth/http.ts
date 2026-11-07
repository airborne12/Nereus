// HTTP side of authentication: request bodies, the session cookie, login throttling, and the
// /api/auth, /api/keys and /api/users endpoints.
//
// Cross-site request forgery: state-changing requests must be JSON (POST) or DELETE. A browser
// can only send those cross-origin after a CORS preflight, and this server answers no
// preflight, so another site cannot make a logged-in browser call them. The cookie is also
// SameSite=Lax.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthError, type AuthStore, type Role, type User } from './store.ts';

export const SESSION_COOKIE = 'ds_session';
const SESSION_MAX_AGE_S = 7 * 86400;
const MAX_BODY = 64 * 1024;

export interface AuthContext {
  store: AuthStore;
  /** Add `Secure` to the cookie (serve over HTTPS). */
  secureCookie: boolean;
}

type Send = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string | string[]>) => void;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new AuthError(415, 'request body must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AuthError(413, 'request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new AuthError(400, 'request body is not a JSON object');
  }
}

function str(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string') throw new AuthError(400, `'${key}' must be a string`);
  return v;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // A cookie another app set with a stray '%' must not fail every request: skip it.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // not ours; ignored
    }
  }
  return out;
}

function sessionCookie(ctx: AuthContext, token: string | null): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_MAX_AGE_S : 0}`];
  if (ctx.secureCookie) attrs.push('Secure');
  return `${SESSION_COOKIE}=${token ?? ''}; ${attrs.join('; ')}`;
}

/** The bearer token (API key) or session cookie of a request. */
function requestToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (h) {
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) throw new AuthError(401, 'Authorization header must be "Bearer <API key>"');
    return m[1]!;
  }
  return cookies(req)[SESSION_COOKIE] ?? null;
}

export async function authenticate(ctx: AuthContext, req: IncomingMessage): Promise<User | null> {
  const token = requestToken(req);
  return token ? ctx.store.userForToken(token) : null;
}

/** Failed logins per client address and email: 10 in 5 minutes, then 429 until the window ends. */
class LoginThrottle {
  private failures = new Map<string, { n: number; until: number }>();
  check(key: string): void {
    const f = this.failures.get(key);
    if (f && f.until > Date.now() && f.n >= 10) throw new AuthError(429, 'too many failed logins, try again later');
  }
  fail(key: string): void {
    const now = Date.now();
    const f = this.failures.get(key);
    if (!f || f.until <= now) this.failures.set(key, { n: 1, until: now + 5 * 60_000 });
    else f.n++;
    if (this.failures.size > 100_000) for (const [k, v] of this.failures) if (v.until <= now) this.failures.delete(k);
  }
  ok(key: string): void {
    this.failures.delete(key);
  }
}

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export function authRoutes(ctx: AuthContext, send: Send) {
  const throttle = new LoginThrottle();

  /** /api/auth/*: no login needed. Returns false when the path is not one of them. */
  async function handlePublic(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === '/api/auth/status' && req.method === 'GET') {
      const user = await authenticate(ctx, req).catch(() => null);
      send(res, 200, { setupRequired: (await ctx.store.userCount()) === 0, user: user && publicUser(user) });
      return true;
    }
    if (path === '/api/auth/setup' && req.method === 'POST') {
      const b = await readJson(req);
      const user = await ctx.store.setup(str(b, 'email'), str(b, 'name', false), str(b, 'password'));
      const token = await ctx.store.createSession(user.id);
      send(res, 201, { user: publicUser(user) }, { 'set-cookie': sessionCookie(ctx, token) });
      return true;
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      const b = await readJson(req);
      const email = str(b, 'email');
      const key = `${req.socket.remoteAddress}|${email.trim().toLowerCase()}`;
      throttle.check(key);
      const user = await ctx.store.checkPassword(email, str(b, 'password'));
      if (!user) {
        throttle.fail(key);
        throw new AuthError(401, 'wrong email or password');
      }
      throttle.ok(key);
      const token = await ctx.store.createSession(user.id);
      send(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(ctx, token) });
      return true;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      await readJson(req);
      const token = cookies(req)[SESSION_COOKIE];
      if (token) await ctx.store.deleteSession(token);
      send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(ctx, null) });
      return true;
    }
    return false;
  }

  /** /api/keys and /api/users for a logged-in user. Returns false when the path is not one of them. */
  async function handleAccount(req: IncomingMessage, res: ServerResponse, path: string, user: User): Promise<boolean> {
    if (path === '/api/keys' && req.method === 'GET') {
      send(res, 200, { keys: await ctx.store.listApiKeys(user.id) });
      return true;
    }
    if (path === '/api/keys' && req.method === 'POST') {
      const b = await readJson(req);
      send(res, 201, await ctx.store.createApiKey(user.id, str(b, 'name')));
      return true;
    }
    const key = /^\/api\/keys\/(\d+)$/.exec(path);
    if (key && req.method === 'DELETE') {
      await ctx.store.revokeApiKey(user.id, Number(key[1]));
      send(res, 200, { ok: true });
      return true;
    }
    if (!path.startsWith('/api/users')) return false;
    if (user.role !== 'admin') throw new AuthError(403, 'only admins can manage users');
    if (path === '/api/users' && req.method === 'GET') {
      send(res, 200, { users: await ctx.store.listUsers() });
      return true;
    }
    if (path === '/api/users' && req.method === 'POST') {
      const b = await readJson(req);
      const role = (str(b, 'role', false) || 'member') as Role;
      const created = await ctx.store.createUser(str(b, 'email'), str(b, 'name', false), str(b, 'password'), role);
      send(res, 201, { user: created });
      return true;
    }
    const dis = /^\/api\/users\/(\d+)\/disabled$/.exec(path);
    if (dis && req.method === 'POST') {
      const b = await readJson(req);
      if (typeof b.disabled !== 'boolean') throw new AuthError(400, "'disabled' must be true or false");
      if (Number(dis[1]) === user.id && b.disabled) throw new AuthError(400, 'you cannot disable yourself');
      send(res, 200, { user: await ctx.store.setDisabled(Number(dis[1]), b.disabled) });
      return true;
    }
    return false;
  }

  return { handlePublic, handleAccount };
}
