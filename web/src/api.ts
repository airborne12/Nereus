import type { Row, Span } from './lib/rows.ts';
import type { SourceName } from './lib/state.ts';

export class ApiError extends Error {}

async function get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const res = await fetch(`${path}?${qs}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

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
