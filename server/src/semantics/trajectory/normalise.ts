// Turns the capture records of one session into rows of the agent tables (spec 6.2). Pure: no I/O,
// and the same records always give the same rows. Mutation is confined to the accumulators of one
// call of normalise(); every row it returns is a fresh object.

import { argsHash, blockHash, canonicalJson } from './hash.ts';
import {
  type Block, type CallRecord, type CaptureRecord, type CompactionRecord, type ContextRow, type CtxChange, dorisTime, type ErrorRecord,
  type EventKind, type EventRow, type MessageRow, type Normalised, type PromptRecord, type PromptRow, type SessionRecord,
} from './model.ts';
import { resourceOf } from './resource.ts';

/** Doris rejects a STRING value over this many bytes (string_type_length_soft_limit_bytes). */
export const TEXT_LIMIT = 10 * 1024 * 1024;
/** Bytes of a failed tool result kept in the event's error column. */
export const ERROR_LIMIT = 2000;

/** The longest prefix of `text` within `limit` UTF-8 bytes, never splitting a character. */
export function cutUtf8(text: string, limit: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, cut: false };
  let end = limit;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), cut: true };
}

/** Message numbers as inclusive runs of consecutive numbers, in list order. */
export function toRanges(msgs: readonly number[]): { from: number; to: number }[] {
  return msgs.reduce<{ from: number; to: number }[]>((out, m) => {
    const last = out[out.length - 1];
    return last && m === last.to + 1 ? [...out.slice(0, -1), { from: last.from, to: m }] : [...out, { from: m, to: m }];
  }, []);
}

function blankEvent(sid: string, seq: number, ts: string, turn: number, step: number, kind: EventKind, gapUs: number): EventRow {
  return {
    session_id: sid, seq, ts: dorisTime(ts), turn, step, kind, parent_seq: null, name: null, status: '', error: null,
    end_ts: null, duration_us: null, ttft_us: null, gap_us: gapUs, model: null, stop_reason: null, request_id: null, attempt: null,
    input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    ctx_msgs: null, ctx_prefix: null, ctx_change: null, ctx_exact: null, prompt_hash: null,
    msg_seq: null, result_msg: null, tool_call_id: null, resource: null, args: null, args_hash: null,
    repeat_of: null, repeat_visible: null, trace_id: null, span_id: null, attrs: null,
  };
}

const commonPrefix = (a: readonly number[], b: readonly number[]): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
};

interface Context { blocks: number[]; change: CtxChange; exact: boolean; request: string | null }

export function normalise(session: SessionRecord, records: readonly CaptureRecord[]): Normalised {
  const sid = session.id;
  const messages = new Map<number, MessageRow>();
  const events = new Map<number, EventRow>();
  const contexts: ContextRow[] = [];
  const prompts = new Map<string, PromptRow>();
  const hashToMsg = new Map<string, number>();
  const apiOrdinal = new Map<string, number>();
  const blocksOf = new Map<string, number[]>();
  const toolCalls = new Map<string, number>();
  const startMs = new Map<number, number>();
  const firstByArgs = new Map<string, number>();
  const requests = new Map<string, string[][]>();
  const history: number[] = [];
  const inHistory = new Set<number>();
  const n = { seq: 0, msg: 0, turn: 0, step: 0 };
  let lastEndMs: number | null = null;
  let turnInput: number | null = null;
  let lastCall: { request: string | null; blocks: number[] } | null = null;
  let compactedSince = false;
  let lastCompaction: number | null = null;

  const gapUs = (ms: number) => (lastEndMs === null ? 0 : Math.max(0, Math.round((ms - lastEndMs) * 1000)));
  const ended = (ms: number) => { lastEndMs = lastEndMs === null ? ms : Math.max(lastEndMs, ms); };

  function addBlock(b: Block, eventSeq: number | null): number {
    if (!apiOrdinal.has(b.apiMsg)) apiOrdinal.set(b.apiMsg, apiOrdinal.size + 1);
    const hash = blockHash(b.role, b.kind, b.text, b.payload, b.toolCallId);
    const known = hashToMsg.get(hash);
    const m = known ?? ++n.msg;
    if (known === undefined) {
      hashToMsg.set(hash, m);
      const bytes = Buffer.byteLength(b.text, 'utf8');
      const cut = cutUtf8(b.text, TEXT_LIMIT);
      messages.set(m, {
        session_id: sid, msg_seq: m, ts: dorisTime(b.ts), content_hash: hash, msg_role: b.role, kind: b.kind,
        api_msg: apiOrdinal.get(b.apiMsg)!, event_seq: eventSeq, tool_name: b.toolName, tool_call_id: b.toolCallId,
        is_error: b.isError, bytes, tokens: Math.ceil(bytes / 4), truncated: cut.cut, text: cut.text, payload: b.payload ?? null,
      });
    }
    const list = blocksOf.get(b.apiMsg);
    if (!list) blocksOf.set(b.apiMsg, [m]);
    else if (!list.includes(m)) list.push(m);
    if (!inHistory.has(m)) { inHistory.add(m); history.push(m); }
    return m;
  }

  function contextOf(c: CallRecord): Context {
    const d = c.context;
    if (!d) return { blocks: [...history], change: compactedSince ? 'compact' : lastCall ? 'append' : 'fresh', exact: false, request: null };
    const base = d.base === null ? [] : requests.get(d.base);
    const baseLen = base?.length ?? 0;
    const units = [...(base ?? []).slice(0, d.keep), ...d.tail];
    requests.set(d.request, units);
    const seen = new Set<number>();
    const blocks: number[] = [];
    for (const key of units.flat()) {
      for (const m of blocksOf.get(key) ?? []) if (!seen.has(m)) { seen.add(m); blocks.push(m); }
    }
    const change: CtxChange = compactedSince ? 'compact' : d.base === null ? 'fresh'
      : d.base === lastCall?.request && d.keep === baseLen ? 'append' : d.keep < baseLen ? 'truncate' : 'append';
    return { blocks, change, exact: d.exact && base !== undefined, request: d.request };
  }

  function writeContext(seq: number, ts: string, ctx: Context): void {
    const row = (rel: 'in' | 'out') => (r: { from: number; to: number }, pos: number): ContextRow =>
      ({ session_id: sid, seq, rel, pos, ts: dorisTime(ts), from_msg: r.from, to_msg: r.to });
    contexts.push(...toRanges(ctx.blocks).map(row('in')));
    if (ctx.change === 'append' || !lastCall) return;
    const kept = new Set(ctx.blocks);
    contexts.push(...toRanges(lastCall.blocks.filter((m) => !kept.has(m))).map(row('out')));
  }

  function addToolCalls(c: CallRecord, llmSeq: number, msgs: number[], inCtx: Set<number>): void {
    c.blocks.forEach((b, i) => {
      if (b.kind !== 'tool_use' || !b.toolName) return;
      const seq = ++n.seq;
      const hash = argsHash(b.toolName, b.payload);
      const first = firstByArgs.get(hash);
      if (first === undefined) firstByArgs.set(hash, seq);
      const earlier = first === undefined ? undefined : events.get(first);
      events.set(seq, {
        ...blankEvent(sid, seq, c.endTs, n.turn, n.step, 'tool_call', 0), parent_seq: llmSeq, name: b.toolName, tool_call_id: b.toolCallId,
        resource: resourceOf(b.toolName, b.payload), args: b.payload ?? null, args_hash: hash, repeat_of: first ?? null,
        repeat_visible: earlier ? earlier.result_msg !== null && inCtx.has(earlier.result_msg) : null, msg_seq: msgs[i] ?? null,
      });
      startMs.set(seq, Date.parse(c.endTs));
      if (b.toolCallId) toolCalls.set(b.toolCallId, seq);
    });
  }

  function onCall(c: CallRecord): void {
    n.step += 1;
    const seq = ++n.seq;
    const begin = Date.parse(c.startTs);
    const end = Date.parse(c.endTs);
    const ctx = contextOf(c);
    writeContext(seq, c.startTs, ctx);
    const msgs = c.blocks.map((b) => addBlock(b, seq));
    events.set(seq, {
      ...blankEvent(sid, seq, c.startTs, n.turn, n.step, 'llm_call', gapUs(begin)), name: c.model, status: 'ok',
      end_ts: dorisTime(c.endTs), duration_us: Math.max(0, (end - begin) * 1000), model: c.model, stop_reason: c.stopReason,
      request_id: c.requestId, input_tokens: c.usage?.input ?? null, output_tokens: c.usage?.output ?? null,
      cache_read_tokens: c.usage?.cacheRead ?? null, cache_write_tokens: c.usage?.cacheWrite ?? null,
      ctx_msgs: ctx.blocks.length, ctx_prefix: commonPrefix(lastCall?.blocks ?? [], ctx.blocks), ctx_change: ctx.change,
      ctx_exact: ctx.exact, prompt_hash: c.promptHash, msg_seq: msgs[0] ?? null,
    });
    ended(end);
    lastCall = { request: ctx.request, blocks: ctx.blocks };
    compactedSince = false;
    addToolCalls(c, seq, msgs, new Set(ctx.blocks));
  }

  function onInput(b: Block, opensTurn: boolean): void {
    const at = Date.parse(b.ts);
    if (b.kind === 'tool_result' && b.toolCallId) {
      const callSeq = toolCalls.get(b.toolCallId);
      const call = callSeq === undefined ? undefined : events.get(callSeq);
      const m = addBlock({ ...b, toolName: call?.name ?? b.toolName }, callSeq ?? null);
      if (!call || callSeq === undefined) return;
      events.set(callSeq, {
        ...call, status: b.isError ? 'error' : 'ok', error: b.isError ? cutUtf8(b.text, ERROR_LIMIT).text : null,
        end_ts: dorisTime(b.ts), duration_us: Math.max(0, (at - (startMs.get(callSeq) ?? at)) * 1000), result_msg: m,
      });
      ended(at);
      return;
    }
    if (!opensTurn) {
      addBlock(b, b.kind === 'summary' ? lastCompaction : null);
      return;
    }
    n.turn += 1;
    const seq = ++n.seq;
    const m = addBlock(b, seq);
    events.set(seq, { ...blankEvent(sid, seq, b.ts, n.turn, n.step, 'user_input', gapUs(at)), msg_seq: m });
    turnInput = seq;
    ended(at);
  }

  function onCompaction(r: CompactionRecord): void {
    const seq = ++n.seq;
    const at = Date.parse(r.ts);
    events.set(seq, { ...blankEvent(sid, seq, r.ts, n.turn, n.step, 'compaction', gapUs(at)),
      attrs: { trigger: r.trigger, pre_tokens: r.preTokens, post_tokens: r.postTokens } });
    ended(at);
    compactedSince = true;
    lastCompaction = seq;
    history.length = 0;
    inHistory.clear();
  }

  function onError(r: ErrorRecord): void {
    const seq = ++n.seq;
    const at = Date.parse(r.ts);
    events.set(seq, { ...blankEvent(sid, seq, r.ts, n.turn, n.step, 'error', gapUs(at)), status: 'error', error: r.message,
      attempt: r.attempt, attrs: { max_attempts: r.maxAttempts, retry_in_ms: r.retryInMs } });
    ended(at);
  }

  function onPrompt(r: PromptRecord): void {
    if (prompts.has(r.hash)) return;
    const names = r.tools.map((x) => (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : ''));
    prompts.set(r.hash, { prompt_hash: r.hash, system_text: r.system, tools: r.tools, tool_names: names.filter(Boolean),
      bytes: Buffer.byteLength(r.system, 'utf8') + Buffer.byteLength(canonicalJson(r.tools), 'utf8'), first_seen: dorisTime(r.ts) });
  }

  for (const r of records) {
    if (r.type === 'input') onInput(r.block, r.opensTurn);
    else if (r.type === 'call') onCall(r);
    else if (r.type === 'compaction') onCompaction(r);
    else if (r.type === 'error') onError(r);
    else if (r.type === 'prompt') onPrompt(r);
    else if (r.type === 'turn_end' && turnInput !== null) {
      const e = events.get(turnInput)!;
      events.set(turnInput, { ...e, end_ts: dorisTime(r.ts), duration_us: r.durationMs * 1000 });
      ended(Date.parse(r.ts));
    }
  }

  return {
    session,
    messages: [...messages.values()],
    events: [...events.values()].sort((a, b) => a.seq - b.seq),
    contexts,
    prompts: [...prompts.values()],
    toolCallSeqs: new Map(toolCalls),
  };
}
