// Search page state, kept in the URL so every view can be shared and reloaded.

export type SourceName = 'logs' | 'traces';

export const PRESETS = ['15m', '1h', '6h', '24h', '7d'] as const;
export type Preset = (typeof PRESETS)[number];

const PRESET_MS: Record<Preset, number> = {
  '15m': 15 * 60_000,
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
};

/** A relative window ending now, or a fixed one (epoch ms, UTC). */
export type TimeWindow = { preset: Preset } | { from: number; to: number };

export interface SearchState {
  source: SourceName;
  q: string;
  window: TimeWindow;
  /** trace id shown in the trace panel */
  trace: string | null;
}

export const DEFAULT_STATE: SearchState = { source: 'logs', q: '', window: { preset: '1h' }, trace: null };

export function resolveWindow(w: TimeWindow, now: number): { from: number; to: number } {
  return 'preset' in w ? { from: now - PRESET_MS[w.preset], to: now } : { from: w.from, to: w.to };
}

export function parseState(search: string): SearchState {
  const p = new URLSearchParams(search);
  const source = p.get('source') === 'traces' ? 'traces' : 'logs';
  const preset = p.get('t');
  const from = Number(p.get('from'));
  const to = Number(p.get('to'));
  let window: TimeWindow = DEFAULT_STATE.window;
  if (preset && (PRESETS as readonly string[]).includes(preset)) window = { preset: preset as Preset };
  else if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from) window = { from, to };
  const trace = p.get('trace');
  return { source, q: p.get('q') ?? '', window, trace: trace && /^[0-9a-f]{32}$/.test(trace) ? trace : null };
}

export function serializeState(s: SearchState): string {
  const p = new URLSearchParams();
  p.set('source', s.source);
  if (s.q) p.set('q', s.q);
  if ('preset' in s.window) p.set('t', s.window.preset);
  else {
    p.set('from', String(Math.round(s.window.from)));
    p.set('to', String(Math.round(s.window.to)));
  }
  if (s.trace) p.set('trace', s.trace);
  return `?${p}`;
}

/** Doris DATETIME(6) text (UTC) to epoch ms. */
export function dorisTimeToMs(t: string): number {
  return Date.parse(`${t.replace(' ', 'T')}Z`);
}
