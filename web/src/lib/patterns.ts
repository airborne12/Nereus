// Event patterns: group log lines that differ only in variable parts (numbers, ids, hosts).
// A light-weight stand-in for Drain run on a sample, like ClickStack's Event Patterns tab.

const RULES: [RegExp, string][] = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>'],
  [/\b[0-9a-f]{16,}\b/gi, '<hex>'],
  [/"[^"]*"/g, '"<*>"'],
  [/\b\d+(?:\.\d+)?(?:ms|s|us|µs|%)?\b/g, '<num>'],
];

export function template(text: string): string {
  let t = text;
  for (const [re, rep] of RULES) t = t.replace(re, rep);
  return t.replace(/\s+/g, ' ').trim();
}

export interface Pattern {
  pattern: string;
  /** Rows of the sample in this pattern. */
  count: number;
  /** Most common level among them. */
  level: string;
  /** Counts per time bin, oldest first. */
  trend: number[];
  samples: Record<string, unknown>[];
}

export function minePatterns(
  rows: Record<string, unknown>[], field: string, levelField: string, from: number, to: number, bins = 24,
  toMs: (r: Record<string, unknown>) => number,
): Pattern[] {
  const groups = new Map<string, Pattern & { levels: Map<string, number> }>();
  for (const r of rows) {
    const key = template(String(r[field] ?? ''));
    let g = groups.get(key);
    if (!g) {
      g = { pattern: key, count: 0, level: '', trend: new Array(bins).fill(0), samples: [], levels: new Map() };
      groups.set(key, g);
    }
    g.count++;
    const lvl = String(r[levelField] ?? '');
    g.levels.set(lvl, (g.levels.get(lvl) ?? 0) + 1);
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(((toMs(r) - from) / (to - from)) * bins)));
    g.trend[bin]!++;
    if (g.samples.length < 50) g.samples.push(r);
  }
  return [...groups.values()]
    .map(({ levels, ...p }) => ({ ...p, level: [...levels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }))
    .sort((a, b) => b.count - a.count);
}
