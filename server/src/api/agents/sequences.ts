// Sequences (spec 7, 8.5): what happens after a kind of event, and the places where the steps of a
// pattern follow one another.
//
//   GET  /api/agents/sequences/next?from=&to=&start=failed|user|tool:<name>&depth=
//   GET  /api/agents/sequences/tools?from=&to=
//   POST /api/agents/sequences/match   {from, to, pattern, sort, dir, limit, offset}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '../../control/auth/http.ts';
import type { Doris } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { matchSql } from '../../semantics/sequences/match.ts';
import { parsePattern } from '../../semantics/sequences/pattern.ts';
import { MAX_DEPTH, parseStart, pathsSql, pathTree, type PathRow, toolsSql } from '../../semantics/sequences/paths.ts';
import { PAGE_LIMIT } from '../../semantics/trajectory/query.ts';
import { intParam, run, type Send } from './request.ts';

const MATCH = '/api/agents/sequences/match';

function rangeOf(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) throw new CompileError("'from' and 'to' are required");
  return { from, to };
}

/** The read routes of the Sequences page. */
export async function sequences(doris: Doris, db: string, send: Send, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.searchParams;
  if (url.pathname === '/api/agents/sequences/next') {
    const raw = p.get('start');
    const start = parseStart(raw);
    const depth = intParam(url, 'depth', MAX_DEPTH, 0);
    const statement = pathsSql(db, { ...rangeOf(p.get('from'), p.get('to')), start, depth });
    const { results, elapsedMs } = await run(doris, [statement]);
    send(res, 200, { start: start.kind === 'tool' ? `tool:${start.tool}` : start.kind, depth, ...pathTree(results[0] as unknown as PathRow[], depth), sql: [statement], elapsedMs });
    return true;
  }
  if (url.pathname === '/api/agents/sequences/tools') {
    const range = rangeOf(p.get('from'), p.get('to'));
    const statement = toolsSql(db, range.from, range.to);
    const { results, elapsedMs } = await run(doris, [statement]);
    send(res, 200, { tools: results[0]!.map((r) => ({ name: String(r.name), calls: Number(r.calls) })), sql: [statement], elapsedMs });
    return true;
  }
  return false;
}

/** The pattern route: the request arrives as a JSON body, since a pattern is a list of objects. */
export async function sequenceMatch(doris: Doris, db: string, send: Send, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== MATCH) return false;
  const b = await readJson(req);
  const pattern = parsePattern(b.pattern);
  const text = (v: unknown, name: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new CompileError(`'${name}' must be text`);
    return v;
  };
  const { rows, total, matches } = matchSql(db, {
    ...rangeOf(b.from, b.to), pattern, sort: text(b.sort, 'sort'), dir: text(b.dir, 'dir') as 'asc' | 'desc' | undefined,
    limit: (b.limit ?? PAGE_LIMIT) as number, offset: (b.offset ?? 0) as number,
  });
  const { results, elapsedMs } = await run(doris, [rows, total]);
  const counts = results[1]![0];
  send(res, 200, { rows: matches(results[0]!), matches: Number(counts?.matches ?? 0), sessions: Number(counts?.sessions ?? 0), pattern, sql: [rows, total], elapsedMs });
  return true;
}
