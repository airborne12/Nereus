// Natural-language time ranges for the time picker: "last 2 hours", "past 30m", "3h ago",
// "since 10 minutes ago", "today", "yesterday", "this week", "last week", "2026-11-04 10:00 to 12:00".
// Returns null when the text is not understood.

import { localTime, parseLocalTime } from './time.ts';

const UNITS: Record<string, number> = {
  s: 1e3, sec: 1e3, second: 1e3, m: 6e4, min: 6e4, minute: 6e4, h: 36e5, hr: 36e5, hour: 36e5,
  d: 864e5, day: 864e5, w: 6048e5, week: 6048e5,
};

function unitMs(u: string): number | undefined {
  const k = u.toLowerCase().replace(/s$/, '');
  return UNITS[k] ?? UNITS[u.toLowerCase()];
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseLocal(s: string, day: number | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (m && day !== null) {
    const d = new Date(day);
    return localTime(d.getFullYear(), d.getMonth() + 1, d.getDate(), Number(m[1]), Number(m[2]));
  }
  return parseLocalTime(s);
}

export function parseNaturalRange(text: string, now: number): { from: number; to: number } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  let m = /^(?:last|past|previous) (\d+(?:\.\d+)?) ?([a-z]+)$/.exec(t);
  if (m && unitMs(m[2]!)) return { from: now - Number(m[1]) * unitMs(m[2]!)!, to: now };
  m = /^(?:last|past) (hour|day|week|minute)$/.exec(t);
  if (m && t !== 'last week') return { from: now - unitMs(m[1]!)!, to: now };
  m = /^(?:since )?(\d+(?:\.\d+)?) ?([a-z]+) ago$/.exec(t);
  if (m && unitMs(m[2]!)) return { from: now - Number(m[1]) * unitMs(m[2]!)!, to: now };
  if (t === 'today') return { from: startOfDay(now), to: now };
  if (t === 'yesterday') return { from: startOfDay(now) - 864e5, to: startOfDay(now) };
  const dow = (new Date(now).getDay() + 6) % 7; // Monday = 0
  if (t === 'this week') return { from: startOfDay(now) - dow * 864e5, to: now };
  if (t === 'last week') return { from: startOfDay(now) - (dow + 7) * 864e5, to: startOfDay(now) - dow * 864e5 };
  m = /^(.+?) (?:to|-|–) (.+)$/.exec(text.trim());
  if (m) {
    const a = parseLocal(m[1]!, null);
    const b = a === null ? null : parseLocal(m[2]!, startOfDay(a));
    if (a !== null && b !== null && b > a) return { from: a, to: b };
  }
  return null;
}
