// The two read-only trajectory tools (spec 7) for agents that write memories: `trajectory_search`
// runs the statement of the Sessions, Steps or Messages page, and `trajectory_read` the statements
// of the session page for a session's turns, one turn or one step. A wrong argument is a tool
// error whose text says why, so the model can call again.

import type { Doris } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { messagesPage, sessionsPage, stepsPage } from '../../semantics/trajectory/pages.ts';
import { type Page, parseCondition, tableSql } from '../../semantics/trajectory/query.ts';
import { sessionId, stepSql, treeSql, turnSql, turnStepsSql, turnsSql } from '../../semantics/trajectory/session.ts';
import { parsed, run } from '../agents/request.ts';
import type { Tool, ToolResult, ToolSet } from './protocol.ts';

/** Rows one search answers at most. */
export const SEARCH_LIMIT = 50;
/** Turns one read of a session answers at most. */
const TURNS_LIMIT = 200;
/** Characters of one answer at most; a longer one is cut and says so. */
const MAX_TEXT = 60_000;
const WEEK_MS = 7 * 86_400_000;
const PAGES: Record<string, (db: string) => Page> = { sessions: sessionsPage, steps: stepsPage, messages: messagesPage };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: Tool[] = [
  {
    name: 'trajectory_search', title: 'Search agent trajectories', annotations: READ_ONLY,
    description: 'Finds sessions, steps (model calls with their tool calls) or messages of the AI agent sessions Nereus keeps, newest first, '
      + 'with the columns of that table. Use it to find the session a memory came from, or the sessions where something happened.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: ['sessions', 'steps', 'messages'], description: 'What a row is' },
        q: { type: 'string', description: 'Words that must all match; quotes make a phrase' },
        conditions: { type: 'array', items: { type: 'string' }, description: 'Each column:op:value, op one of eq ne lt le gt ge contains' },
        from: { type: 'string', description: 'Start of the time range, ISO 8601; 7 days before `to` when not given' },
        to: { type: 'string', description: 'End of the time range, ISO 8601; now when not given' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT, description: `Rows to answer, at most ${SEARCH_LIMIT}; 20 when not given` },
        offset: { type: 'integer', minimum: 0, description: 'Rows to skip' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'trajectory_read', title: 'Read an agent session', annotations: READ_ONLY,
    description: "Reads one session of an AI agent: without turn or seq, its sessions (the main one and its sub-agents) and its turns; "
      + 'with turn, the request and final answer of that turn and its first 100 steps; with seq, one step: what the model wrote and the calls it made.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'A session id, as trajectory_search answers it' },
        turn: { type: 'integer', minimum: 1, description: 'A turn of the session' },
        seq: { type: 'integer', minimum: 0, description: 'The seq of a step (a model call) of the session' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
];

const whole = (v: unknown, name: string, min: number): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new CompileError(`${name} must be a whole number from ${min}`);
  return v;
};
const time = (v: unknown, name: string, fallback: number): number => {
  if (v === undefined) return fallback;
  const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(ms)) throw new CompileError(`${name} must be a time in ISO 8601, such as 2026-11-19T10:00:00Z`);
  return ms;
};

async function search(doris: Doris, db: string, args: Record<string, unknown>, now: number): Promise<unknown> {
  const page = PAGES[String(args.table)];
  if (!page) throw new CompileError('table must be sessions, steps or messages');
  if (args.conditions !== undefined && !Array.isArray(args.conditions)) throw new CompileError('conditions must be a list of column:op:value');
  const to = time(args.to, 'to', now);
  const from = time(args.from, 'from', to - WEEK_MS);
  const limit = Math.min(whole(args.limit, 'limit', 1) ?? 20, SEARCH_LIMIT);
  const conditions = ((args.conditions as unknown[] | undefined) ?? []).map((c) => parseCondition(String(c)));
  const p = page(db);
  const req = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), q: typeof args.q === 'string' ? args.q : '', conditions, limit, offset: whole(args.offset, 'offset', 0) ?? 0 };
  const { rows, total } = tableSql(p, req, 'list');
  const { results } = await run(doris, [rows, total]);
  return { table: p.name, total: Number(results[1]![0]?.total ?? 0), from: req.from, to: req.to, rows: parsed(results[0]!) };
}

async function read(doris: Doris, db: string, args: Record<string, unknown>): Promise<unknown> {
  const id = sessionId(String(args.session_id ?? ''));
  const turn = whole(args.turn, 'turn', 1);
  const seq = whole(args.seq, 'seq', 0);
  if (seq !== undefined) {
    const s = stepSql(db, id, seq, 0);
    const { results: [event, output] } = await run(doris, [s.event, s.output]);
    if (!event![0]) throw new CompileError('no such step in this session');
    return { session_id: id, seq, step: parsed(event!)[0], output: parsed(output!) };
  }
  if (turn !== undefined) {
    const { results: [blocks, steps] } = await run(doris, [turnSql(db, id, turn), turnStepsSql(db, id, turn, 0)]);
    return { session_id: id, turn, blocks, steps };
  }
  const { results: [sessions] } = await run(doris, [treeSql(db, id)]);
  if (!sessions!.length) throw new CompileError('no such session');
  const { results: [turns] } = await run(doris, [turnsSql(db, sessions!.map((r) => String(r.session_id)))]);
  return { session_id: id, sessions: parsed(sessions!), turns: turns!.slice(0, TURNS_LIMIT), cut: turns!.length > TURNS_LIMIT };
}

function textOf(v: unknown): ToolResult {
  const s = JSON.stringify(v);
  const text = s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… (cut: ${s.length - MAX_TEXT} more characters; read one turn or one step for less)` : s;
  return { content: [{ type: 'text', text }] };
}

/** The tools on one database; `now` is the time a search's range ends by default. */
export function trajectoryTools(doris: Doris, db: string, now: () => number = Date.now): ToolSet {
  return {
    list: TOOLS,
    call: async (name, args) => {
      if (name !== 'trajectory_search' && name !== 'trajectory_read') return null;
      try {
        return textOf(name === 'trajectory_search' ? await search(doris, db, args, now()) : await read(doris, db, args));
      } catch (e) {
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    },
  };
}
