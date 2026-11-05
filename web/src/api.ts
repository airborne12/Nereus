import type { Row, Span } from './lib/rows.ts';
import type { Filter, Language, SourceName } from './lib/state.ts';

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
  // Only a body that is not JSON is tolerated; an abort while reading must stay an abort, or a
  // superseded request would "succeed" with an empty object.
  const body = await res.json().catch((e: unknown) => {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return {};
  });
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

/** What every data call filters on: source, WHERE in its language, filters and the time range. */
export interface Spec {
  source: SourceName;
  where: string;
  language: Language;
  filters: Filter[];
  range: Range;
}

function specParams(s: Spec): Record<string, string> {
  const p: Record<string, string> = { source: s.source, where: s.where, language: s.language, from: iso(s.range.from), to: iso(s.range.to) };
  if (s.filters.length) p.filters = JSON.stringify(s.filters);
  return p;
}

export interface Column {
  label: string;
  key: string;
}

export interface Warning {
  kind: 'unknown_field';
  field: string;
  suggestion: string | null;
}

export function search(s: Spec, opts: { select?: string; orderBy?: string; limit: number; offset?: number }, signal?: AbortSignal) {
  return get<{ rows: Row[]; columns: Column[]; sql: string; elapsedMs: number; warnings: Warning[] }>('/api/search', {
    ...specParams(s), select: opts.select || undefined, orderBy: opts.orderBy || undefined, limit: opts.limit,
    offset: opts.offset || undefined,
  }, signal);
}

export interface Bucket {
  t: string;
  g?: string;
  n: string | number;
}

export function histogram(s: Spec, groupBy: string, signal?: AbortSignal, groups?: number) {
  return get<{ stepSeconds: number; buckets: Bucket[]; sql: string }>('/api/histogram',
    { ...specParams(s), groupBy, buckets: 90, ...(groups ? { groups } : {}) }, signal);
}

export interface Facet {
  field: string;
  values: { v: string; n: number }[];
}

export function facets(s: Spec, signal?: AbortSignal) {
  return get<{ sampled: number; facets: Facet[] }>('/api/facets', specParams(s), signal);
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

// ---------------------------------------------------------------- saved searches, dashboards, alerts, charts

export interface SavedSearch {
  id: number;
  name: string;
  source: SourceName;
  where: string;
  language: Language;
  filters: Filter[];
  select: string;
  orderBy: string;
  tags: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  favorite: boolean;
  alertState: 'OK' | 'ALERT' | 'ERROR' | null;
}

export type ChartSourceName = SourceName | 'metrics';
export type Aggregate = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p90' | 'p95' | 'p99';
export const AGGREGATES: Aggregate[] = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'p50', 'p90', 'p95', 'p99'];

export interface ChartDef {
  source: ChartSourceName;
  display: 'line' | 'table' | 'number';
  series: { agg: Aggregate; field?: string }[];
  where: string;
  language: Language;
  filters: Filter[];
  groupBy?: string;
}

export interface Tile {
  id: string;
  title: string;
  chart: ChartDef;
  w: number;
}

export interface Dashboard {
  id: number;
  name: string;
  tiles: Tile[];
  tags: string[];
  createdBy: string | null;
  updatedAt: string;
  favorite: boolean;
}

export interface Webhook {
  id: number;
  name: string;
  url?: string;
}

export interface Alert {
  id: number;
  /** An alert watches a saved search or a dashboard tile. */
  savedSearchId: number | null;
  savedSearchName: string | null;
  dashboardId: number | null;
  dashboardName: string | null;
  tileId: string | null;
  tileTitle: string | null;
  /** "p99(duration)" for a tile alert. */
  tileMetric: string | null;
  /** The group whose value was last reported, for a grouped tile. */
  lastGroup: string | null;
  webhookId: number;
  webhookName: string | null;
  thresholdType: 'above' | 'below';
  threshold: number;
  intervalSeconds: number;
  state: 'OK' | 'ALERT' | 'ERROR';
  lastCheckedAt: string | null;
  lastValue: number | null;
  silencedUntil: string | null;
}

export interface AlertCheck {
  checkedAt: string;
  value: number | null;
  group: string | null;
  state: string;
  error: string | null;
  notified: boolean;
}

export const content = {
  searches: () => get<{ items: SavedSearch[] }>('/api/saved-searches', {}),
  search: (id: number) => get<SavedSearch>(`/api/saved-searches/${id}`, {}),
  createSearch: (s: Partial<SavedSearch>) => send<SavedSearch>('POST', '/api/saved-searches', s),
  updateSearch: (id: number, s: Partial<SavedSearch>) => putJson<SavedSearch>(`/api/saved-searches/${id}`, s),
  deleteSearch: (id: number) => send<{ ok: true }>('DELETE', `/api/saved-searches/${id}`),
  favoriteSearch: (id: number, on: boolean) => send<{ ok: true }>('POST', `/api/saved-searches/${id}/favorite`, { on }),
  dashboards: () => get<{ items: Dashboard[] }>('/api/dashboards', {}),
  dashboard: (id: number) => get<Dashboard>(`/api/dashboards/${id}`, {}),
  createDashboard: (d: Partial<Dashboard>) => send<Dashboard>('POST', '/api/dashboards', d),
  updateDashboard: (id: number, d: Partial<Dashboard>) => putJson<Dashboard>(`/api/dashboards/${id}`, d),
  deleteDashboard: (id: number) => send<{ ok: true }>('DELETE', `/api/dashboards/${id}`),
  favoriteDashboard: (id: number, on: boolean) => send<{ ok: true }>('POST', `/api/dashboards/${id}/favorite`, { on }),
  webhooks: () => get<{ items: Webhook[] }>('/api/webhooks', {}),
  createWebhook: (name: string, url: string) => send<Webhook>('POST', '/api/webhooks', { name, url }),
  deleteWebhook: (id: number) => send<{ ok: true }>('DELETE', `/api/webhooks/${id}`),
  testWebhook: (id: number) => send<{ ok: true }>('POST', `/api/webhooks/${id}/test`, {}),
  alerts: (savedSearchId?: number, dashboardId?: number) => get<{ items: Alert[] }>('/api/alerts', { savedSearchId, dashboardId }),
  createAlert: (a: { savedSearchId?: number; dashboardId?: number; tileId?: string; webhookId: number; thresholdType: 'above' | 'below'; threshold: number; intervalSeconds: number }) =>
    send<Alert>('POST', '/api/alerts', a),
  deleteAlert: (id: number) => send<{ ok: true }>('DELETE', `/api/alerts/${id}`),
  silenceAlert: (id: number, minutes: number) => send<{ ok: true }>('POST', `/api/alerts/${id}/silence`, { minutes }),
  alertHistory: (id: number) => get<{ items: AlertCheck[] }>(`/api/alerts/${id}/history`, {}),
};

async function putJson<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

export interface ChartResult {
  rows: Record<string, unknown>[];
  stepSeconds: number | null;
  sql: string;
}

export async function chart(def: ChartDef, r: Range, signal?: AbortSignal): Promise<ChartResult> {
  return parse<ChartResult>(await fetch('/api/chart', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ ...def, from: iso(r.from), to: iso(r.to) }),
  }));
}

export interface MapEdge { src: string; dst: string; calls: number | string; errors: number | string; p50: number | string; p99: number | string }
export interface MapNode { service: string; requests: number | string; errors: number | string; p99: number | string }

export function serviceMap(s: Omit<Spec, 'source'>, signal?: AbortSignal) {
  return get<{ edges: MapEdge[]; nodes: MapNode[] }>('/api/service-map', specParams({ ...s, source: 'traces' }), signal);
}

export function heatmap(s: Omit<Spec, 'source'>, signal?: AbortSignal) {
  return get<{ cells: { t: string; b: number | string; n: number | string }[]; stepSeconds: number }>('/api/heatmap',
    { ...specParams({ ...s, source: 'traces' }), buckets: 60 }, signal);
}

export interface SessionSummary {
  session_id: string;
  started: string;
  ended: string;
  service: string;
  user_email: string | null;
  user_name: string | null;
  user_id: string | null;
  first_url: string | null;
  user_agent: string | null;
  clicks: number | string;
  pages: number | string;
  errors: number | string;
  requests: number | string;
  replay_parts: number | string;
}

export interface SessionEvent {
  t: string;
  type: 'click' | 'navigation' | 'error' | 'console' | 'network' | 'custom';
  url: string | null;
  message: string | null;
  attributes: Record<string, unknown> | null;
}

export interface SessionDetail {
  session: { sessionId: string; service: string; user: { id: string | null; email: string | null; name: string | null }; userAgent: string | null; started: string; ended: string };
  events: SessionEvent[];
  /** rrweb events, one list per recorded chunk. */
  replay: { type: number; timestamp: number }[][];
}

export function sessions(s: Omit<Spec, 'source'>, signal?: AbortSignal) {
  return get<{ sessions: SessionSummary[]; sql: string }>('/api/sessions', specParams({ ...s, source: 'logs' }), signal);
}

export function session(id: string, range: Range, signal?: AbortSignal) {
  return get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`, { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() }, signal);
}

export function sessionForTrace(traceId: string, range: Range, signal?: AbortSignal) {
  return get<{ session: { sessionId: string; at: string; started: string; ended: string; user: string | null } | null }>(
    `/api/sessions/by-trace/${traceId}`, { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() }, signal);
}

export interface IngestKey { id: number; name: string; prefix: string; createdBy: string | null; createdAt: string; lastUsedAt: string | null; revoked: boolean }

export const ingestKeys = {
  list: () => get<{ keys: IngestKey[] }>('/api/ingest-keys', {}),
  create: (name: string) => send<{ key: string; id: number }>('POST', '/api/ingest-keys', { name }),
  revoke: (id: number) => send<{ ok: true }>('DELETE', `/api/ingest-keys/${id}`),
};
