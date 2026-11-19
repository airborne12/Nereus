// Compare (spec 7, 8.4): two sessions' trees and turns, and with `turn` the steps of that pair of
// turns, paired in order.
//
//   GET /api/agents/compare?a=<session id>&b=<session id>&turn=<n>

import type { ServerResponse } from 'node:http';
import type { Doris } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { align, compareSql, turnSide } from '../../semantics/trajectory/compare.ts';
import { intParam, parsed, run, type Send } from './request.ts';

export async function compare(doris: Doris, db: string, send: Send, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/agents/compare') return false;
  const a = url.searchParams.get('a');
  const b = url.searchParams.get('b');
  if (!a || !b) throw new CompileError("'a' and 'b' are required");
  const turn = url.searchParams.has('turn') ? intParam(url, 'turn', 0, 0) : null;
  const statements = compareSql(db, a, b, turn);
  const { results, elapsedMs } = await run(doris, statements);
  const [sessions, turns, steps] = results;
  if (!sessions!.some((s) => s.session_id === a) || !sessions!.some((s) => s.session_id === b)) {
    send(res, 404, { error: 'no such session' });
    return true;
  }
  const pair = steps ? { a: turnSide(steps, a), b: turnSide(steps, b) } : null;
  send(res, 200, {
    sessions: parsed(sessions!), turns, sql: statements, elapsedMs,
    steps: pair ? { a: pair.a.steps, b: pair.b.steps, rows: align(pair.a.steps, pair.b.steps), cuts: { a: pair.a.cuts, b: pair.b.cuts } } : null,
  });
  return true;
}
