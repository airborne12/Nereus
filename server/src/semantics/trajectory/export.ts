// Exports of the agent pages (spec 8.4): a table as CSV, and the sessions as conversations in
// JSON lines. A conversation is one session (or sub-agent session) between two compactions: the
// context of its last model call plus that call's output, so every line is a context the model
// really had. Doris picks the blocks; this module only writes them out (spec 2, exception to rule 1).

import { sessionsPage } from './pages.ts';
import { filterOf, type Statement, type TableRequest } from './query.ts';

type Row = Record<string, unknown>;

/** Most rows a CSV export writes; a larger result is refused so it never comes back cut. */
export const MAX_EXPORT_ROWS = 200_000;
/** Most bytes of text a conversations export writes. */
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
/** Sessions and messages per line in the preview of a conversations export. */
export const PREVIEW_SESSIONS = 3;
export const PREVIEW_MESSAGES = 6;

/** One CSV field: quoted when it holds a comma, a quote or a line break; objects as JSON. */
function field(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(names: readonly string[], rows: readonly Row[]): string {
  return [names.join(','), ...rows.map((r) => names.map((n) => field(r[n])).join(','))].join('\n') + '\n';
}

/**
 * The branches of the trees whose main session matches the Sessions page filter; for a preview,
 * only the most recent PREVIEW_SESSIONS trees.
 */
function treesOf(db: string, req: TableRequest, preview: boolean): string {
  const { from, where } = filterOf(sessionsPage(db), req);
  const roots = `SELECT s.session_id ${from.join(' ')} WHERE ${where.join(' AND ')}`;
  const picked = preview ? `SELECT session_id FROM (${roots} ORDER BY s.last_event_at DESC LIMIT ${PREVIEW_SESSIONS}) r` : roots;
  return `SELECT session_id FROM ${db}.agent_sessions WHERE root_id IN (${picked})`;
}

/** Part numbers of the events, and the last model call of each part. */
function partsCte(db: string, trees: string): string {
  return `WITH calls AS (
  SELECT session_id, seq, kind, prompt_hash,
         sum(if(kind = 'compaction', 1, 0)) OVER (PARTITION BY session_id ORDER BY seq) + 1 AS part
  FROM ${db}.agent_events
  WHERE session_id IN (${trees})
),
last AS (
  SELECT session_id, part, max(seq) AS seq FROM calls WHERE kind = 'llm_call' GROUP BY session_id, part
)`;
}

/** The blocks of each part: the last call's context in order (src 0), then what the call produced (src 1). */
function blocksUnion(db: string, cols: string): string {
  return `SELECT l.session_id, l.part, 0 AS src, c.pos, ${cols}
FROM last l
JOIN ${db}.agent_contexts c ON c.session_id = l.session_id AND c.seq = l.seq AND c.rel = 'in'
JOIN ${db}.agent_messages m ON m.session_id = c.session_id AND m.msg_seq BETWEEN c.from_msg AND c.to_msg
UNION ALL
SELECT l.session_id, l.part, 1 AS src, 0 AS pos, ${cols}
FROM last l
JOIN ${db}.agent_events e ON e.session_id = l.session_id AND (e.seq = l.seq OR e.parent_seq = l.seq)
JOIN ${db}.agent_messages m ON m.session_id = e.session_id AND m.event_seq = e.seq`;
}

const BLOCK_COLS = 'm.msg_seq, m.api_msg, m.msg_role, m.kind, m.tool_name, m.tool_call_id, m.is_error, m.bytes, m.text, m.payload';

export function conversationSql(db: string, req: TableRequest, preview: boolean): { size: Statement; parts: Statement; blocks: Statement } {
  const cte = partsCte(db, treesOf(db, req, preview));
  return {
    size: {
      title: 'Size',
      sql: `${cte}
SELECT count(DISTINCT session_id) AS sessions, count(DISTINCT concat(session_id, '#', part)) AS parts, count(*) AS blocks, coalesce(sum(bytes), 0) AS bytes
FROM (
${blocksUnion(db, 'm.bytes')}
) x`,
    },
    parts: {
      title: 'Sessions and prompts',
      sql: `${cte}
SELECT l.session_id, l.part, s.root_id, s.parent_id, s.kind, s.agent_name, s.model, s.title, p.system_text
FROM last l
JOIN ${db}.agent_sessions s ON s.session_id = l.session_id
JOIN calls c ON c.session_id = l.session_id AND c.seq = l.seq
LEFT JOIN ${db}.agent_prompts p ON p.prompt_hash = c.prompt_hash
ORDER BY s.root_id, s.started_at, l.session_id, l.part`,
    },
    blocks: {
      title: 'Messages',
      sql: `${cte}
${blocksUnion(db, BLOCK_COLS)}
ORDER BY session_id, part, src, pos, msg_seq`,
    },
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  summary?: true;
  tool_calls?: { id: string | null; name: string | null; arguments: unknown }[];
  tool_call_id?: string | null;
  name?: string | null;
  is_error?: boolean;
}

export interface ConversationLine {
  session_id: string; root_id: string; parent_id: string | null; kind: string; agent_name: string | null;
  model: string | null; title: string | null; part: number; messages: ChatMessage[];
}

const json = (v: unknown): unknown => {
  if (typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
};

/** The blocks of one part as chat messages: the blocks of one assistant API message become one message. */
export function chat(blocks: readonly Row[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let api: unknown = null;
  for (const b of blocks) {
    const role = String(b.msg_role);
    const kind = String(b.kind);
    const text = String(b.text ?? '');
    const last = out[out.length - 1];
    const sameCall = role === 'assistant' && last?.role === 'assistant' && api === b.api_msg;
    if (role === 'assistant' && kind === 'thinking') continue;
    if (role === 'assistant' && kind === 'tool_use') {
      const call = { id: (b.tool_call_id as string | null) ?? null, name: (b.tool_name as string | null) ?? null, arguments: json(b.payload) };
      if (sameCall) last!.tool_calls = [...(last!.tool_calls ?? []), call];
      else out.push({ role: 'assistant', content: '', tool_calls: [call] });
    } else if (role === 'assistant') {
      if (sameCall) last!.content = last!.content ? `${last!.content}\n${text}` : text;
      else out.push({ role: 'assistant', content: text });
    } else if (role === 'tool') {
      out.push({ role: 'tool', tool_call_id: (b.tool_call_id as string | null) ?? null, name: (b.tool_name as string | null) ?? null, is_error: b.is_error === true || b.is_error === 1 || b.is_error === '1', content: text });
    } else if (kind === 'summary') out.push({ role: 'user', summary: true, content: text });
    else out.push({ role: role === 'system' ? 'system' : 'user', content: text });
    api = role === 'assistant' ? b.api_msg : null;
  }
  return out;
}

/**
 * Lines of a conversations export from the rows of `parts` and `blocks`. A block listed twice in a
 * part is kept once; a part with nothing from the assistant is left out.
 */
export function conversations(parts: readonly Row[], blocks: readonly Row[], maxMessages = Infinity): ConversationLine[] {
  const byPart = new Map<string, Row[]>();
  const seen = new Map<string, Set<string>>();
  for (const b of blocks) {
    const k = `${String(b.session_id)}#${String(b.part)}`;
    const list = byPart.get(k) ?? [];
    const keys = seen.get(k) ?? new Set<string>();
    const seq = String(b.msg_seq);
    if (!keys.has(seq)) {
      keys.add(seq);
      list.push(b);
    }
    seen.set(k, keys);
    byPart.set(k, list);
  }
  return parts.flatMap((p) => {
    const messages = chat(byPart.get(`${String(p.session_id)}#${String(p.part)}`) ?? []);
    if (!messages.some((m) => m.role === 'assistant')) return [];
    const system: ChatMessage[] = p.system_text === null || p.system_text === undefined ? [] : [{ role: 'system', content: String(p.system_text) }];
    return [{
      session_id: String(p.session_id), root_id: String(p.root_id), parent_id: (p.parent_id as string | null) ?? null, kind: String(p.kind),
      agent_name: (p.agent_name as string | null) ?? null, model: (p.model as string | null) ?? null, title: (p.title as string | null) ?? null,
      part: Number(p.part), messages: [...system, ...messages].slice(0, maxMessages),
    }];
  });
}

/** A file name for an export: the page and the time it was written. */
export function exportName(page: string, ext: 'csv' | 'jsonl', now = new Date()): string {
  return `agent-${page}-${now.toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${ext}`;
}
