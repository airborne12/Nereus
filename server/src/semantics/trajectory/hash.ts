// Canonical JSON and the hashes that identify blocks, API messages and tool arguments.

import { createHash } from 'node:crypto';

/** JSON with keys sorted by code unit and no spaces; undefined members are left out. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Identity of a content block: role, kind and canonical content (spec 6.2). A tool call or result
 * includes its call id, so two identical calls stay two blocks; plain text that repeats is one block.
 */
export function blockHash(role: string, kind: string, text: string, payload: unknown, callId: string | null): string {
  const plain = (payload === null || payload === undefined) && callId === null;
  const content = plain ? text : canonicalJson({ callId, payload: payload ?? null, text });
  return sha256(`${role}\n${kind}\n${content}`);
}

/** The hash Claude Code's request log uses for one API message `{role, content}`. */
export function apiMessageHash(message: unknown): string {
  return sha256(canonicalJson(message));
}

/** Hash of a tool name and its canonical arguments, for finding repeated calls. */
export function argsHash(name: string, args: unknown): string {
  return sha256(`${name}\n${canonicalJson(args ?? null)}`).slice(0, 32);
}
