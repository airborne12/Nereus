// The two read-only trajectory tools (spec 7) for agents that write memories: `trajectory_search`
// runs the statement of the Sessions, Steps or Messages page, and `trajectory_read` the statements
// of the session page for a session's turns, one turn or one step. A wrong argument is a tool
// error whose text says why, so the model can call again.

import type { Doris } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { parseTime } from '../../semantics/search/build.ts';
import { messagesPage, sessionsPage, stepsPage } from '../../semantics/trajectory/pages.ts';
import { type Page, parseCondition, tableSql } from '../../semantics/trajectory/query.ts';
import { sessionId, STEPS_PAGE, stepSql, treeSql, turnSql, turnStepsSql, turnsSql } from '../../semantics/trajectory/session.ts';
import { parsed, run } from '../agents/request.ts';
import { pagedAnswer } from './answer.ts';
import type { Tool, ToolResult, ToolSet } from './protocol.ts';

/** Rows one search answers at most. */
export const SEARCH_LIMIT = 50;
/** Turns one read of a session answers at most. */
const TURNS_LIMIT = 200;
const WEEK_MS = 7 * 86_400_000;
const PAGES: Record<string, (db: string) => Page> = { sessions: sessionsPage, steps: stepsPage, messages: messagesPage };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const OFFSET = 'Items to skip of the list the answer pages: give the next_offset of an answer that was cut';
type Row = Record<string, unknown>;

export const TOOLS: Tool[] = [
  {
    name: 'trajectory_search', title: 'Search agent trajectories', annotations: READ_ONLY,
    description: 'Finds sessions, steps (model calls with their tool calls) or messages of the AI agent sessions Nereus keeps, newest first, '
      + 'with the columns of that table. Use it to find the session a memory came from, or the sessions where something happened. '
      + 'Long text is shortened; an answer too long for one call is cut by whole rows and says the offset of the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: ['sessions', 'steps', 'messages'], description: 'What a row is' },
        q: { type: 'string', description: 'Words that must all match; quotes make a phrase' },
        conditions: { type: 'array', items: { type: 'string' }, description: 'Each column:op:value, op one of eq ne lt le gt ge contains' },
        from: { type: 'string', description: 'Start of the time range, ISO 8601, UTC when no zone is given; 7 days before `to` when not given' },
        to: { type: 'string', description: 'End of the time range, ISO 8601, UTC when no zone is given; now when not given' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT, description: `Rows to answer, at most ${SEARCH_LIMIT}; 20 when not given` },
        offset: { type: 'integer', minimum: 0, description: 'Rows to skip' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'trajectory_read', title: 'Read an agent session', annotations: READ_ONLY,
    description: "Reads one session of an AI agent: without turn or seq, its sessions (the main one and its sub-agents) and its turns, the main session's first; "
      + 'with turn, the request and final answer of that turn and its steps, 100 model calls at a time; with seq, one step: what the model wrote and the calls it made. '
      + 'Long text is shortened; a list too long for one call is cut by whole items and says the offset of the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'A session id, as trajectory_search answers it' },
        turn: { type: 'integer', minimum: 0, description: 'A turn of the session; turn 0 holds what came before the first request' },
        seq: { type: 'integer', minimum: 0, description: 'The seq of a step (a model call) of the session' },
        offset: { type: 'integer', minimum: 0, description: `${OFFSET}: turns of the session, model calls of a turn, or output blocks of a step` },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
];

/** Refuses an argument the tool does not take. */
function only(tool: Tool, args: Row): void {
  const known = Object.keys(tool.inputSchema.properties as Row);
  const other = Object.keys(args).find((k) => !known.includes(k));
  if (other !== undefined) throw new CompileError(`unknown argument ${other}; ${tool.name} takes ${known.join(', ')}`);
}

const whole = (v: unknown, name: string, min: number): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new CompileError(`${name} must be a whole number from ${min}`);
  return v;
};

const time = (v: unknown, name: string, fallback: number): number => {
  if (v === undefined) return fallback;
  try {
    if (typeof v !== 'string') throw new CompileError('not text');
    return parseTime(v);
  } catch {
    throw new CompileError(`${name} must be a time in ISO 8601, such as 2026-11-19T10:00:00Z; one without a zone is UTC`);
  }
};

function searchRequest(args: Row, now: number) {
  only(TOOLS[0]!, args);
  const name = String(args.table);
  if (!Object.hasOwn(PAGES, name)) throw new CompileError('table must be sessions, steps or messages');
  if (args.q !== undefined && typeof args.q !== 'string') throw new CompileError('q must be a string of words');
  if (args.conditions !== undefined && !(Array.isArray(args.conditions) && args.conditions.every((c) => typeof c === 'string'))) {
    throw new CompileError('conditions must be a list of column:op:value');
  }
  const to = time(args.to, 'to', now);
  const from = time(args.from, 'from', to - WEEK_MS);
  const conditions = ((args.conditions as string[] | undefined) ?? []).map(parseCondition);
  const limit = Math.min(whole(args.limit, 'limit', 1) ?? 20, SEARCH_LIMIT);
  return { page: PAGES[name]!, req: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), q: (args.q as string | undefined) ?? '', conditions, limit, offset: whole(args.offset, 'offset', 0) ?? 0 } };
}

async function search(doris: Doris, db: string, args: Row, now: number): Promise<ToolResult> {
  const { page, req } = searchRequest(args, now);
  const p = page(db);
  const { rows, total } = tableSql(p, req, 'list');
  const { results } = await run(doris, [rows, total]);
  const count = Number(results[1]![0]?.total ?? 0);
  const found = parsed(results[0]!);
  return pagedAnswer({ table: p.name, total: count, from: req.from, to: req.to }, 'rows', found, req.offset, req.offset + found.length < count);
}

/** The model calls of a turn as whole items: each with its tool calls and any compaction before it. */
const byCall = (rows: readonly Row[]): { nth: unknown; events: Row[] }[] =>
  rows.reduce<{ nth: unknown; events: Row[] }[]>((all, r) => {
    const last = all.at(-1);
    return last && last.nth === (r.nth ?? null) ? [...all.slice(0, -1), { ...last, events: [...last.events, r] }] : [...all, { nth: r.nth ?? null, events: [r] }];
  }, []);

async function readTurn(doris: Doris, db: string, id: string, turn: number, offset: number): Promise<ToolResult> {
  const { results: [blocks, steps] } = await run(doris, [turnSql(db, id, turn), turnStepsSql(db, id, turn, offset)]);
  if (!blocks!.length && !steps!.length) throw new CompileError('no such turn in this session');
  const calls = byCall(steps!);
  return pagedAnswer({ session_id: id, turn, blocks }, 'steps', calls, offset, calls.length >= STEPS_PAGE);
}

async function readSession(doris: Doris, db: string, id: string, offset: number): Promise<ToolResult> {
  const { results: [sessions] } = await run(doris, [treeSql(db, id)]);
  if (!sessions!.length) throw new CompileError('no such session');
  const rank = new Map(sessions!.map((s, i) => [String(s.session_id), i]));
  const { results: [turns] } = await run(doris, [turnsSql(db, sessions!.map((r) => String(r.session_id)))]);
  const ordered = [...turns!].sort((a, b) => (rank.get(String(a.session_id)) ?? 0) - (rank.get(String(b.session_id)) ?? 0) || Number(a.turn) - Number(b.turn));
  const page = ordered.slice(offset, offset + TURNS_LIMIT);
  return pagedAnswer({ session_id: id, sessions: parsed(sessions!) }, 'turns', page, offset, offset + page.length < ordered.length);
}

async function read(doris: Doris, db: string, args: Row): Promise<ToolResult> {
  only(TOOLS[1]!, args);
  if (typeof args.session_id !== 'string') throw new CompileError('session_id must be a string');
  const id = sessionId(args.session_id);
  const turn = whole(args.turn, 'turn', 0);
  const seq = whole(args.seq, 'seq', 0);
  const offset = whole(args.offset, 'offset', 0) ?? 0;
  if (turn !== undefined && seq !== undefined) throw new CompileError('give turn or seq, not both');
  if (turn !== undefined) return readTurn(doris, db, id, turn, offset);
  if (seq === undefined) return readSession(doris, db, id, offset);
  const s = stepSql(db, id, seq, 0);
  const { results: [event, output] } = await run(doris, [s.event, s.output]);
  if (!event![0]) throw new CompileError('no such step in this session');
  const blocks = parsed(output!);
  return pagedAnswer({ session_id: id, seq, step: parsed(event!)[0] }, 'output', blocks.slice(offset), offset);
}

/** The tools on one database; `now` is the time a search's range ends by default. */
export function trajectoryTools(doris: Doris, db: string, now: () => number = Date.now): ToolSet {
  return {
    list: TOOLS,
    call: async (name, args) => {
      if (name !== 'trajectory_search' && name !== 'trajectory_read') return null;
      try {
        return name === 'trajectory_search' ? await search(doris, db, args, now()) : await read(doris, db, args);
      } catch (e) {
        return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  };
}
