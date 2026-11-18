// Compare (spec 7, 8.4): two sessions' trees and turns, and with `turn` the steps of that pair of
// turns, paired in order.
//
//   GET /api/agents/compare?a=<session id>&b=<session id>&turn=<n>

import type { ServerResponse } from 'node:http';
import type { Doris, Row } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { align, compareSql, type StepFacts } from '../../semantics/trajectory/compare.ts';
import { intParam, parsed, run, type Send } from './request.ts';

const facts = (rows: readonly Row[], id: string): StepFacts[] => rows.filter((r) => r.session_id === id).map((r) => ({
  seq: Number(r.seq), step: Number(r.step), tools: String(r.tools), targets: String(r.targets), failed: Number(r.failed) > 0,
}));

export async function compare(doris: Doris, db: string, send: Send, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/agents/compare') return false;
  const a = url.searchParams.get('a');
  const b = url.searchParams.get('b');
  if (!a || !b) throw new CompileError("'a' and 'b' are required");
  const turn = url.searchParams.has('turn') ? intParam(url, 'turn', 1, 1) : null;
  const statements = compareSql(db, a, b, turn);
  const { results, elapsedMs } = await run(doris, statements);
  const [sessions, turns, steps] = results;
  if (!sessions!.some((s) => s.session_id === a) || !sessions!.some((s) => s.session_id === b)) {
    send(res, 404, { error: 'no such session' });
    return true;
  }
  const pair = steps ? { a: facts(steps, a), b: facts(steps, b) } : null;
  send(res, 200, {
    sessions: parsed(sessions!), turns, steps: pair ? { ...pair, rows: align(pair.a, pair.b) } : null, sql: statements, elapsedMs,
  });
  return true;
}
