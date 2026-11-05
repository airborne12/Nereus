// Search page state, kept in the URL so every view can be shared and reloaded.

export type SourceName = 'logs' | 'traces';
export type Language = 'lucene' | 'sql';

/** Time presets, in ClickStack's order. 'live' is Live Tail over the last 15 minutes. */
export const PRESETS = ['live', '1m', '5m', '15m', '30m', '45m', '1h', '3h', '6h', '12h', '1d', '2d', '7d', '14d', '30d'] as const;
export type Preset = (typeof PRESETS)[number];

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
export function presetMs(p: Preset): number {
  if (p === 'live') return 15 * 60_000;
  return Number(p.slice(0, -1)) * UNIT_MS[p.slice(-1)]!;
}

export function presetLabel(p: Preset): string {
  if (p === 'live') return 'Live Tail';
  const n = Number(p.slice(0, -1));
  const unit = { m: 'minute', h: 'hour', d: 'days' }[p.slice(-1) as 'm' | 'h' | 'd'];
  return unit === 'days' ? `Last ${n} days` : `Last ${n} ${unit}${n > 1 ? 's' : ''}`;
}

/** A relative window ending now, or a fixed one (epoch ms, UTC). */
export type TimeWindow = { preset: Preset } | { from: number; to: number };

export interface Filter {
  field: string;
  values: string[];
  exclude?: boolean;
}

export interface SearchState {
  source: SourceName;
  where: string;
  language: Language;
  filters: Filter[];
  /** Empty: the source's default columns. */
  select: string;
  orderBy: string;
  window: TimeWindow;
  /** The saved search this view was opened from (or saved as). */
  saved: number | null;
}

export const DEFAULT_STATE: SearchState = {
  source: 'logs', where: '', language: 'lucene', filters: [], select: '', orderBy: '', window: { preset: 'live' }, saved: null,
};

export const DEFAULT_SELECT: Record<SourceName, string> = {
  logs: 'timestamp, service_name, severity_text, body',
  traces: 'timestamp, service_name, status_code, round(duration / 1000, 1), span_name',
};

export function resolveWindow(w: TimeWindow, now: number): { from: number; to: number } {
  return 'preset' in w ? { from: now - presetMs(w.preset), to: now } : { from: w.from, to: w.to };
}

function parseFilters(raw: string | null): Filter[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((f) => typeof f?.field === 'string' && Array.isArray(f.values) && f.values.length > 0)
      .map((f) => ({ field: f.field, values: f.values.map(String), ...(f.exclude ? { exclude: true } : {}) })) : [];
  } catch {
    return [];
  }
}

export function parseState(search: string): SearchState {
  const p = new URLSearchParams(search);
  const preset = p.get('t');
  const from = Number(p.get('from'));
  const to = Number(p.get('to'));
  let window: TimeWindow = DEFAULT_STATE.window;
  if (preset && (PRESETS as readonly string[]).includes(preset)) window = { preset: preset as Preset };
  else if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from) window = { from, to };
  return {
    source: p.get('source') === 'traces' ? 'traces' : 'logs',
    // `q` was the WHERE parameter before SQL mode; old links keep working.
    where: p.get('where') ?? p.get('q') ?? '',
    language: p.get('lang') === 'sql' ? 'sql' : 'lucene',
    filters: parseFilters(p.get('filters')),
    select: p.get('select') ?? '',
    orderBy: p.get('orderBy') ?? '',
    window,
    saved: /^\d+$/.test(p.get('saved') ?? '') ? Number(p.get('saved')) : null,
  };
}

export function serializeState(s: SearchState): string {
  const p = new URLSearchParams();
  p.set('source', s.source);
  if (s.where) p.set('where', s.where);
  if (s.language === 'sql') p.set('lang', 'sql');
  if (s.filters.length) p.set('filters', JSON.stringify(s.filters));
  if (s.select) p.set('select', s.select);
  if (s.orderBy) p.set('orderBy', s.orderBy);
  if (s.saved !== null) p.set('saved', String(s.saved));
  if ('preset' in s.window) p.set('t', s.window.preset);
  else {
    p.set('from', String(Math.round(s.window.from)));
    p.set('to', String(Math.round(s.window.to)));
  }
  return `?${p}`;
}

/** Doris DATETIME(6) text (UTC) to epoch ms. */
export function dorisTimeToMs(t: string): number {
  return Date.parse(`${t.replace(' ', 'T')}Z`);
}

/** Toggle one value of a field filter: include it, exclude it, or show only it. */
export function toggleFilter(filters: Filter[], field: string, value: string, mode: 'include' | 'exclude' | 'only'): Filter[] {
  const others = filters.filter((f) => f.field !== field);
  const cur = filters.find((f) => f.field === field);
  if (mode === 'only') return [...others, { field, values: [value] }];
  const exclude = mode === 'exclude';
  if (!cur || Boolean(cur.exclude) !== exclude) return [...others, { field, values: [value], ...(exclude ? { exclude: true } : {}) }];
  const values = cur.values.includes(value) ? cur.values.filter((v) => v !== value) : [...cur.values, value];
  return values.length ? [...others, { ...cur, values }] : others;
}
