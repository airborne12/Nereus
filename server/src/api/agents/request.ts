// What the agent routes share: reading a request's parameters, running statements, and answering
// with the rows, the SQL that ran and the elapsed time (spec 7).

import type { ServerResponse } from 'node:http';
import type { Doris, Row } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { MAX_LIMIT, PAGE_LIMIT, parseCondition, type Statement, type TableRequest } from '../../semantics/trajectory/query.ts';

export type Send = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string | string[]>) => void;

/** A non-negative integer parameter within [min, max], or `fallback` when absent. */
export function intParam(url: URL, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return fallback;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new CompileError(`'${name}' must be an integer from ${min} to ${max}`);
  return Number(v);
}

/** The table request of Sessions, Steps and Messages: from, to, q, f (repeated), sort, dir, limit, offset. */
export function tableRequest(url: URL): TableRequest {
  const p = url.searchParams;
  const from = p.get('from');
  const to = p.get('to');
  if (!from || !to) throw new CompileError("'from' and 'to' are required");
  const dir = p.get('dir') ?? undefined;
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') throw new CompileError("'dir' must be asc or desc");
  return {
    from, to, q: p.get('q') ?? '', conditions: p.getAll('f').map(parseCondition), sort: p.get('sort') ?? undefined, dir,
    limit: intParam(url, 'limit', PAGE_LIMIT, 1, MAX_LIMIT), offset: intParam(url, 'offset', 0),
  };
}

/** Runs statements at the same time; rows come back in statement order. */
export async function run(doris: Doris, statements: readonly Statement[]): Promise<{ results: Row[][]; elapsedMs: number }> {
  const started = performance.now();
  const results = await Promise.all(statements.map((s) => doris.query(s.sql)));
  return { results, elapsedMs: Math.round(performance.now() - started) };
}

/** VARIANT and ARRAY columns arrive as JSON text; these are parsed into values. */
const JSON_COLUMNS = ['args', 'attrs', 'payload', 'tools', 'tool_names', 'config', 'events', 'steps'];

export function parsed(rows: readonly Row[]): Row[] {
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const c of JSON_COLUMNS) {
      const v = out[c];
      if (typeof v !== 'string') continue;
      try { out[c] = JSON.parse(v); } catch { /* not JSON: kept as text */ }
    }
    return out;
  });
}

/** Writes a file as the answer, so the browser saves it. */
export function sendFile(res: ServerResponse, name: string, type: string, text: string): void {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`, 'content-length': body.length, 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${name}"`,
  });
  res.end(body);
}
