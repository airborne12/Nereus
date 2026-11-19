// The text of a tool answer: JSON that always parses. Every long string is shortened with how much
// was left out, and a list too long for one answer comes back as whole items with the offset of
// the rest.

import type { ToolResult } from './protocol.ts';

/** Characters of one answer at most. */
export const MAX_TEXT = 60_000;
/** Characters of one string of an answer at most. */
export const ITEM_CHARS = 4_000;
const NOTE = 'Call again with offset set to next_offset for the rest.';

/** A value with every string over ITEM_CHARS cut and marked. */
export function shorten(v: unknown): unknown {
  if (typeof v === 'string') return v.length > ITEM_CHARS ? `${v.slice(0, ITEM_CHARS)}… (${v.length - ITEM_CHARS} more characters)` : v;
  if (Array.isArray(v)) return v.map(shorten);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]));
  return v;
}

const text = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

/**
 * An answer whose list `key` starts at `offset`: as many whole items as fit, and when some are left
 * out or `more` says the source has more, `cut` with how many came back and the offset of the rest.
 */
export function pagedAnswer(head: Record<string, unknown>, key: string, items: readonly unknown[], offset: number, more = false): ToolResult {
  const all = items.map(shorten);
  const top = shorten(head) as Record<string, unknown>;
  const body = (n: number) => ({
    ...top, [key]: all.slice(0, n),
    ...(n < all.length || more ? { cut: { returned: n, next_offset: offset + n, note: NOTE } } : {}),
  });
  const fits = (n: number) => JSON.stringify(body(n)).length <= MAX_TEXT;
  // The most items that fit, found by halving; one item is always given.
  let [lo, hi] = [1, all.length];
  if (fits(hi)) lo = hi;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return text(body(Math.min(lo, all.length)));
}
