// Editing the search bar text from the UI: adding "field is / is not value" filters.

/** A value as one quoted search bar token: quotes and backslashes are escaped. */
export function quoteValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Append `field:"value"` (or `-field:"value"`) unless the query already has that exact filter. */
export function addFilter(q: string, field: string, value: string, exclude = false): string {
  const token = `${exclude ? '-' : ''}${field}:${quoteValue(value)}`;
  const opposite = `${exclude ? '' : '-'}${field}:${quoteValue(value)}`;
  // Match whole tokens only: pad with spaces so a filter at either end is found too.
  const padded = ` ${q.trim()} `;
  if (padded.includes(` ${token} `)) return q.trim();
  const kept = padded.split(` ${opposite} `).join(' ').trim();
  return kept ? `${kept} ${token}` : token;
}

/** The token being typed at `cursor`: its start, its text, and the field if it is `field:val`. */
export function tokenAt(q: string, cursor: number): { start: number; end: number; field: string | null; value: string } {
  let start = cursor;
  while (start > 0 && !/[\s(]/.test(q[start - 1]!)) start--;
  let end = cursor;
  while (end < q.length && !/[\s)]/.test(q[end]!)) end++;
  const text = q.slice(start, cursor).replace(/^-/, '');
  const offset = q[start] === '-' ? 1 : 0;
  const colon = text.indexOf(':');
  if (colon < 0) return { start: start + offset, end, field: null, value: text };
  return { start: start + offset, end, field: text.slice(0, colon), value: text.slice(colon + 1).replace(/^"/, '') };
}
