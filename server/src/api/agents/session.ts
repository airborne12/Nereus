// The session page (spec 7, 8.3): the tree with its turns, a turn's steps one page at a time, and
// what the right side reads for a turn, a step or a compaction.
//
//   GET /api/agents/sessions/<id>                                 tree, turns, marks; every step when the tree is small
//   GET /api/agents/sessions/<id>/turns/<n>                       the user's input and the final answer
//   GET /api/agents/sessions/<id>/turns/<n>/steps?offset=         100 steps of a turn
//   GET /api/agents/sessions/<id>/steps/<seq>?inputOffset=        input, output and prompt of a model call
//   GET /api/agents/sessions/<id>/events/<seq>/compaction         replaced blocks and the summary

import type { ServerResponse } from 'node:http';
import type { Doris } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import {
  compactionSql, marksSql, OPEN_ALL_STEPS, sessionId, STEPS_PAGE, stepSql, treeSql, treeStepsSql, turnSql, turnStepsSql, turnsSql,
} from '../../semantics/trajectory/session.ts';
import { intParam, parsed, run, type Send } from './request.ts';

async function tree(doris: Doris, db: string, send: Send, res: ServerResponse, id: string): Promise<void> {
  const head = treeSql(db, id);
  const { results: [sessions], elapsedMs } = await run(doris, [head]);
  if (sessions!.length === 0) return send(res, 404, { error: 'no such session' });
  const ids = sessions!.map((s) => String(s.session_id));
  const main = sessions!.find((s) => s.kind === 'main') ?? sessions![0]!;
  const openAll = Number(main.steps ?? 0) <= OPEN_ALL_STEPS;
  const statements = [turnsSql(db, ids), marksSql(db, ids), ...(openAll ? [treeStepsSql(db, ids)] : [])];
  const { results, elapsedMs: more } = await run(doris, statements);
  send(res, 200, {
    sessions: parsed(sessions!), turns: results[0], marks: results[1], steps: openAll ? results[2] : null, openAll,
    sql: [head, ...statements], elapsedMs: elapsedMs + more,
  });
}

async function step(doris: Doris, db: string, send: Send, res: ServerResponse, id: string, seq: number, url: URL): Promise<void> {
  const s = stepSql(db, id, seq, intParam(url, 'inputOffset', 0));
  const { results: [event, input, output, prompt], elapsedMs } = await run(doris, [s.event, s.input, s.output, s.prompt]);
  const e = event![0];
  if (!e) return send(res, 404, { error: 'no such model call' });
  const total = Number(e.ctx_msgs ?? 0);
  send(res, 200, {
    step: parsed([e])[0], input: input, inputTotal: total, inputNew: total - Number(e.ctx_prefix ?? 0),
    output: parsed(output!), prompt: prompt![0] ? parsed(prompt!)[0] : null, sql: [s.event, s.input, s.output, s.prompt], elapsedMs,
  });
}

async function compaction(doris: Doris, db: string, send: Send, res: ServerResponse, id: string, seq: number): Promise<void> {
  const c = compactionSql(db, id, seq);
  const { results: [event, blocks], elapsedMs } = await run(doris, [c.event, c.blocks]);
  if (!event![0]) return send(res, 404, { error: 'no such compaction' });
  send(res, 200, {
    event: parsed(event!)[0], replaced: blocks!.filter((b) => b.rel === 'out'), summary: blocks!.filter((b) => b.rel === 'in'),
    sql: [c.event, c.blocks], elapsedMs,
  });
}

/** Answers a session page path; false when the path is not one. */
export async function session(doris: Doris, db: string, send: Send, res: ServerResponse, url: URL): Promise<boolean> {
  const m = /^\/api\/agents\/sessions\/([^/]+)(?:\/(turns|steps|events)\/(\d+)(\/steps|\/compaction)?)?$/.exec(url.pathname);
  if (!m) return false;
  let raw: string;
  try { raw = decodeURIComponent(m[1]!); } catch { throw new CompileError('bad session id'); }
  const id = sessionId(raw);
  const [what, n, tail] = [m[2], Number(m[3]), m[4]];
  if (!what) await tree(doris, db, send, res, id);
  else if (what === 'turns' && !tail) {
    const t = turnSql(db, id, n);
    const { results: [blocks], elapsedMs } = await run(doris, [t]);
    send(res, 200, { blocks, sql: [t], elapsedMs });
  } else if (what === 'turns' && tail === '/steps') {
    const offset = intParam(url, 'offset', 0);
    const t = turnStepsSql(db, id, n, offset);
    const { results: [steps], elapsedMs } = await run(doris, [t]);
    send(res, 200, { steps, offset, pageSize: STEPS_PAGE, sql: [t], elapsedMs });
  } else if (what === 'steps' && !tail) await step(doris, db, send, res, id, n, url);
  else if (what === 'events' && tail === '/compaction') await compaction(doris, db, send, res, id, n);
  else send(res, 404, { error: 'not found' });
  return true;
}
