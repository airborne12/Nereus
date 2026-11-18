// How the agent pages write times, sizes and counts: one form everywhere.

const two = (n: number) => String(n).padStart(2, '0');

/** A time as `YYYY-MM-DD HH:MM:SS` in the viewer's time zone. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** The time of day of `stamp`. */
export const clock = (ms: number): string => stamp(ms).slice(11);

/** A Doris DATETIME(6) text (UTC) as epoch ms; null when there is no time. */
export function timeOf(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const ms = Date.parse(`${v.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** A number column as a number; big integers arrive as text. Missing values count as 0. */
export function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The first line of a text that has words, without the tags a runtime wraps a command in. */
export function plainLine(value: string): string {
  const lines = value.split('\n').map((l) => l.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  return lines.find((l) => l !== '') ?? '';
}

/** A count of tokens: 950, 12.3k, 1.25M. */
export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** A duration given in microseconds: 0.4s, 12.5s, 3m 20s, 1h 5m. */
export function duration(us: number): string {
  const s = us / 1e6;
  if (s < 59.95) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  const minutes = Math.round(s / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** The size of a file: 512 bytes, 2.9 KB, 1.2 MB. */
export function fileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/** The viewer's time zone, as shown beside every time range. */
export const timeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
