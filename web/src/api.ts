import type { Row, Span } from './lib/rows.ts';
import type { SourceName } from './lib/state.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Called when any request answers 401, so the app can show the login page. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(f: () => void): void {
  onUnauthorized = f;
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body as T;
}

async function get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  return parse<T>(await fetch(`${path}?${qs}`, { signal }));
}

async function send<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return parse<T>(await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'member';
  disabled?: boolean;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export const auth = {
  // status must not trigger the 401 handler: it is how the app learns it is logged out.
  status: async () => (await fetch('/api/auth/status')).json() as Promise<{ setupRequired: boolean; user: User | null }>,
  setup: (email: string, name: string, password: string) => send<{ user: User }>('POST', '/api/auth/setup', { email, name, password }),
  login: (email: string, password: string) => send<{ user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => send<{ ok: true }>('POST', '/api/auth/logout', {}),
  keys: () => get<{ keys: ApiKey[] }>('/api/keys', {}),
  createKey: (name: string) => send<{ key: string; apiKey: ApiKey }>('POST', '/api/keys', { name }),
  revokeKey: (id: number) => send<{ ok: true }>('DELETE', `/api/keys/${id}`),
  users: () => get<{ users: User[] }>('/api/users', {}),
  createUser: (u: { email: string; name: string; password: string; role: 'admin' | 'member' }) =>
    send<{ user: User }>('POST', '/api/users', u),
  setDisabled: (id: number, disabled: boolean) => send<{ user: User }>('POST', `/api/users/${id}/disabled`, { disabled }),
};

const iso = (ms: number) => new Date(ms).toISOString();

export interface Range {
  from: number;
  to: number;
}

export function search(source: SourceName, q: string, r: Range, limit: number, signal?: AbortSignal) {
  return get<{ rows: Row[]; elapsedMs: number }>('/api/search',
    { source, q, from: iso(r.from), to: iso(r.to), limit }, signal);
}

export interface Bucket {
  t: string;
  g?: string;
  n: string | number;
}

export function histogram(source: SourceName, q: string, r: Range, groupBy: string, signal?: AbortSignal) {
  return get<{ stepSeconds: number; buckets: Bucket[] }>('/api/histogram',
    { source, q, from: iso(r.from), to: iso(r.to), groupBy, buckets: 90 }, signal);
}

export function trace(id: string, r: Range, signal?: AbortSignal) {
  return get<{ spans: Span[] }>(`/api/trace/${id}`, { from: iso(r.from), to: iso(r.to) }, signal);
}

export function fields(source: SourceName, signal?: AbortSignal) {
  return get<{ fields: { name: string; type: string }[] }>('/api/fields', { source }, signal);
}

export function values(source: SourceName, field: string, q: string, r: Range, signal?: AbortSignal) {
  return get<{ values: { v: string; n: string | number }[] }>('/api/values',
    { source, field, q, from: iso(r.from), to: iso(r.to), limit: 10 }, signal);
}
