// Reads one Claude Code transcript file (JSON lines) into capture records (spec 6.3). It knows the
// format and makes no decisions: numbering, contexts and block identity are the normaliser's.

import { apiMessageHash, canonicalJson } from '../trajectory/hash.ts';
import type { Block, BlockKind, CallRecord, CaptureRecord, ContextDelta, InputRecord, Role, Usage } from '../trajectory/model.ts';

type Raw = Record<string, unknown>;

export interface TranscriptResult {
  records: CaptureRecord[];
  title: string | null;
  runtimeVersion: string | null;
  startedAt: string | null;
  /** Rows of types the adapter does not read, by type. */
  skipped: Record<string, number>;
  malformed: number;
  /** Request-log tail hashes that match no message of the file. */
  unresolved: number;
  hasRequestLog: boolean;
}

/** Bookkeeping rows with no trajectory content. */
const IGNORED = new Set(['session-owner', 'atis-latch', 'last-prompt', 'queue-operation', 'tools-used', 'cost-state', 'file-history-snapshot', 'summary']);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Raw | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const messageOf = (r: Raw): Raw => obj(r.message) ?? {};
const tsOf = (r: Raw, fallback: string): string => str(r.timestamp) ?? fallback;
const asItems = (content: unknown): unknown[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : list(content));

/** Readable text of message or tool-result content: its text items, other items by type. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content).map((c) => {
    const o = obj(c);
    if (!o) return '';
    return o.type === 'text' ? (str(o.text) ?? '') : `[${String(o.type)}]`;
  }).filter(Boolean).join('\n');
}

function block(role: Role, kind: BlockKind, apiMsg: string, text: string, ts: string, extra: Partial<Block> = {}): Block {
  return { role, kind, apiMsg, text, payload: null, toolName: null, toolCallId: null, isError: null, ts, ...extra };
}

/** The blocks of one row's content. `textKind` is the kind given to text items. */
function blocksOf(role: Role, content: unknown, apiMsg: string, ts: string, textKind: BlockKind = 'text'): Block[] {
  return asItems(content).flatMap((c): Block[] => {
    const o = obj(c);
    if (!o) return [];
    if (o.type === 'text') return [block(role, textKind, apiMsg, str(o.text) ?? '', ts)];
    if (o.type === 'thinking') return [block(role, 'thinking', apiMsg, str(o.thinking) ?? '', ts)];
    if (o.type === 'redacted_thinking') return [];
    if (o.type === 'tool_use') {
      const name = str(o.name) ?? 'unknown';
      return [block(role, 'tool_use', apiMsg, `${name} ${canonicalJson(o.input ?? null)}`, ts, { payload: o.input ?? null, toolName: name, toolCallId: str(o.id) })];
    }
    if (o.type === 'tool_result') {
      return [block('tool', 'tool_result', apiMsg, contentText(o.content), ts, { toolCallId: str(o.tool_use_id), isError: o.is_error === true })];
    }
    return [block(role, 'attachment', apiMsg, `[${String(o.type)}]`, ts)];
  });
}

function usageOf(u: unknown): Usage | null {
  const o = obj(u);
  if (!o) return null;
  return { input: num(o.input_tokens) ?? 0, output: num(o.output_tokens) ?? 0, cacheRead: num(o.cache_read_input_tokens) ?? 0, cacheWrite: num(o.cache_creation_input_tokens) ?? 0 };
}

function parse(lines: readonly string[]): { rows: Raw[]; malformed: number } {
  const rows: Raw[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = obj(JSON.parse(line));
      if (r) rows.push(r);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

interface Index {
  blobs: Map<string, Raw>; requests: Map<string, Raw>; groups: Map<string, Raw[]>; byHash: Map<string, string[]>;
  /** Requests that a model answer refers to. */
  answered: Set<string>;
}

/** First pass: what later rows refer to, and every API message of the file by its hash. */
function indexRows(rows: readonly Raw[]): Index {
  const blobs = new Map<string, Raw>();
  const requests = new Map<string, Raw>();
  const groups = new Map<string, Raw[]>();
  const answered = new Set<string>();
  for (const r of rows) {
    if (r.type === 'assistant' && str(r.requestRef) && !isSynthetic(r)) answered.add(r.requestRef as string);
    if (r.type === 'api-request-blob' && str(r.hash)) blobs.set(r.hash as string, messageOf(r));
    else if (r.type === 'api-request' && str(r.id)) requests.set(r.id as string, r);
    else if (r.type === 'assistant' && str(messageOf(r).id)) {
      const id = messageOf(r).id as string;
      groups.set(id, [...(groups.get(id) ?? []), r]);
    }
  }
  const byHash = new Map<string, string[]>();
  for (const [id, rs] of groups) byHash.set(apiMessageHash({ role: 'assistant', content: assistantContent(rs) }), [id]);
  // A run of consecutive user rows can be sent as one API message.
  let run: Raw[] = [];
  const flush = () => {
    const h = apiMessageHash({ role: 'user', content: run.flatMap((r) => asItems(messageOf(r).content)) });
    if (run.length > 1 && !byHash.has(h)) byHash.set(h, run.map((r) => String(r.uuid)));
    run = [];
  };
  for (const r of rows) {
    if (r.type === 'user') {
      // String content may be sent as written or as one text item; both forms name this row.
      const content = messageOf(r).content;
      for (const form of [content, asItems(content)]) {
        const h = apiMessageHash({ role: 'user', content: form });
        if (!byHash.has(h)) byHash.set(h, [String(r.uuid)]);
      }
      run = [...run, r];
    } else if (r.type === 'assistant') flush();
  }
  flush();
  return { blobs, requests, groups, byHash, answered };
}

/**
 * A request's base, keep and tail hashes, with a base that never got an answer replaced by its own
 * base: the first `keep` messages of that base are its kept prefix followed by part of its tail.
 */
function throughUnanswered(ix: Index, req: Raw): { base: string | null; keep: number; tail: string[] } {
  let base = str(req.base);
  let keep = num(req.keep) ?? 0;
  let tail = list(req.tail).map(String);
  const seen = new Set<string>();
  while (base !== null && !ix.answered.has(base) && !seen.has(base)) {
    seen.add(base);
    const b = ix.requests.get(base);
    if (!b) break;
    const baseKeep = num(b.keep) ?? 0;
    tail = [...list(b.tail).map(String).slice(0, Math.max(0, keep - baseKeep)), ...tail];
    keep = Math.min(keep, baseKeep);
    base = str(b.base);
  }
  return { base, keep, tail };
}

const ordered = (rs: readonly Raw[]): Raw[] => [...rs].sort((a, b) => (num(a.apiBlockIndex) ?? 0) - (num(b.apiBlockIndex) ?? 0));
const assistantContent = (rs: readonly Raw[]): unknown[] => ordered(rs).flatMap((r) => list(messageOf(r).content));

function userRecords(r: Raw, ts: string): InputRecord[] {
  const id = String(r.uuid);
  const content = messageOf(r).content;
  if (r.isCompactSummary === true) return [{ type: 'input', block: block('user', 'summary', id, contentText(content), ts), opensTurn: false }];
  const blocks = blocksOf('user', content, id, ts);
  const human = r.isMeta !== true && !blocks.some((b) => b.kind === 'tool_result');
  const first = human ? blocks.findIndex((b) => b.kind === 'text') : -1;
  return blocks.map((b, i) => ({ type: 'input', block: b, opensTurn: i === first }));
}

function attachmentRecords(r: Raw, ts: string): InputRecord[] {
  const rendered = list(r.rendered).map((x) => contentText(obj(x)?.content)).filter(Boolean).join('\n');
  const text = rendered || canonicalJson(r.attachment ?? null);
  return [{ type: 'input', block: block('user', 'attachment', String(r.uuid), text, ts), opensTurn: false }];
}

function systemRecord(r: Raw, ts: string): CaptureRecord | null {
  if (r.subtype === 'compact_boundary') {
    const m = obj(r.compactMetadata);
    return { type: 'compaction', ts, trigger: str(m?.trigger), preTokens: num(m?.preTokens), postTokens: num(m?.postTokens) };
  }
  if (r.subtype === 'api_error') {
    return { type: 'error', ts, message: str(obj(r.error)?.message) ?? str(r.content) ?? 'API error',
      attempt: num(r.retryAttempt), maxAttempts: num(r.maxRetries), retryInMs: num(r.retryInMs) };
  }
  if (r.subtype === 'turn_duration') return { type: 'turn_end', ts, durationMs: num(r.durationMs) ?? 0 };
  return null;
}

/** An assistant message the client wrote itself, such as an API or login error; no model call made it. */
const isSynthetic = (r: Raw): boolean => r.isApiErrorMessage === true || messageOf(r).model === '<synthetic>';

function syntheticError(r: Raw, ts: string): CaptureRecord {
  return { type: 'error', ts, message: contentText(messageOf(r).content) || 'API error', attempt: null, maxAttempts: null, retryInMs: null };
}

export function readTranscript(lines: readonly string[]): TranscriptResult {
  const { rows, malformed } = parse(lines);
  const ix = indexRows(rows);
  const hasRequestLog = ix.requests.size > 0;
  const records: CaptureRecord[] = [];
  const skipped: Record<string, number> = {};
  const emittedCalls = new Set<string>();
  const emittedBlobs = new Set<string>();
  const count = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  let unresolved = 0;
  let title: string | null = null;
  let runtimeVersion: string | null = null;
  let startedAt: string | null = null;

  /** One tail hash to the apiMsg keys of its message; a blob is emitted as input the first time. */
  const resolve = (hash: string, ts: string): string[] | null => {
    const keys = ix.byHash.get(hash);
    if (keys) return keys;
    const blob = ix.blobs.get(hash);
    if (!blob) { unresolved += 1; return null; }
    const key = `blob:${hash}`;
    if (!emittedBlobs.has(key)) {
      emittedBlobs.add(key);
      const role: Role = blob.role === 'assistant' ? 'assistant' : 'user';
      for (const b of blocksOf(role, blob.content, key, ts, 'attachment')) {
        records.push({ type: 'input', block: { ...b, kind: b.kind === 'text' || b.kind === 'tool_result' ? 'attachment' : b.kind }, opensTurn: false });
      }
    }
    return [key];
  };

  const callRecord = (id: string, rs: Raw[]): CallRecord => {
    const rows = ordered(rs);
    const first = rs[0]!;
    const last = rows.reduce((a, b) => ((str(b.timestamp) ?? '') > (str(a.timestamp) ?? '') ? b : a));
    const ref = str(first.requestRef);
    const req = ref ? ix.requests.get(ref) : undefined;
    const startTs = (req && str(req.timestamp)) ?? tsOf(first, '');
    const endTs = tsOf(last, startTs);
    let context: ContextDelta | null = null;
    if (req && ref) {
      const d = throughUnanswered(ix, req);
      const tail = d.tail.map((h) => resolve(h, startTs));
      context = { request: ref, base: d.base, keep: d.keep, tail, exact: tail.every((t) => t !== null) };
    }
    const msg = messageOf(last);
    return { type: 'call', blocks: rows.flatMap((r) => blocksOf('assistant', messageOf(r).content, id, tsOf(r, endTs))),
      requestId: str(first.requestId), model: str(msg.model), startTs, endTs, usage: usageOf(msg.usage), stopReason: str(msg.stop_reason),
      promptHash: req ? str(req.shapeHash) : null, context };
  };

  for (const r of rows) {
    const ts = str(r.timestamp);
    if (ts && !startedAt) startedAt = ts;
    if (str(r.version)) runtimeVersion = r.version as string;
    const when = ts ?? startedAt ?? new Date(0).toISOString();
    if (r.type === 'ai-title') title = str(r.aiTitle) ?? title;
    else if (r.type === 'user') records.push(...userRecords(r, when));
    else if (r.type === 'attachment') { if (!hasRequestLog) records.push(...attachmentRecords(r, when)); }
    else if (r.type === 'assistant' && isSynthetic(r)) records.push(syntheticError(r, when));
    else if (r.type === 'assistant') {
      const id = str(messageOf(r).id);
      if (id && !emittedCalls.has(id)) { emittedCalls.add(id); records.push(callRecord(id, ix.groups.get(id)!)); }
    } else if (r.type === 'system') {
      const rec = systemRecord(r, when);
      if (rec) records.push(rec);
      else count(`system:${String(r.subtype)}`);
    } else if (r.type === 'api-request-shape' && str(r.shapeHash)) {
      const shape = obj(r.shape);
      records.push({ type: 'prompt', hash: r.shapeHash as string, system: contentText(shape?.system), tools: list(shape?.tools), ts: when });
    } else if (r.type !== 'api-request' && r.type !== 'api-request-blob' && !IGNORED.has(String(r.type))) count(String(r.type));
  }
  return { records, title, runtimeVersion, startedAt, skipped, malformed, unresolved, hasRequestLog };
}
