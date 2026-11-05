// Recent queries per source and language, newest first, kept in this browser only.

export const HISTORY_MAX = 10;

export function pushHistory(list: string[], q: string, max = HISTORY_MAX): string[] {
  const t = q.trim();
  if (!t) return list;
  return [t, ...list.filter((x) => x !== t)].slice(0, max);
}

const key = (source: string, language: string) => `dorisstack.history.${source}.${language}`;

export function loadHistory(source: string, language: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(source, language)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberQuery(source: string, language: string, q: string): void {
  try {
    localStorage.setItem(key(source, language), JSON.stringify(pushHistory(loadHistory(source, language), q)));
  } catch {
    // Storage may be blocked (private window); history is a convenience only.
  }
}
