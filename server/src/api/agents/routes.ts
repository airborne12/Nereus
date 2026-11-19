// The agent trajectory API (spec 7): read routes under /api/agents/. Every answer carries the
// statements that ran and the elapsed time. Query errors are CompileError and answer 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User } from '../../control/auth/store.ts';
import type { Doris } from '../../db/doris.ts';
import { compare } from './compare.ts';
import { type JudgeAccess, judgeRoutes } from './judges.ts';
import { mcp } from './mcp.ts';
import { memory } from './memories.ts';
import type { Send } from './request.ts';
import { sequenceMatch, sequences } from './sequences.ts';
import { session } from './session.ts';
import { tables } from './tables.ts';

export function agentRoutes(o: { doris: Doris; db: string; send: Send; judges?: JudgeAccess }) {
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, user?: User): Promise<boolean> {
    if (!url.pathname.startsWith('/api/agents/')) return false;
    const { doris, db, send } = o;
    if (await judgeRoutes(o, req, res, url, user)) return true;
    if (await mcp(doris, db, send, req, res, url)) return true;
    // The other post: a pattern arrives as a body. It reads only.
    if (req.method === 'POST') return sequenceMatch(doris, db, send, req, res, url);
    if (req.method !== 'GET') return false;
    if (await tables(doris, db, send, res, url)) return true;
    if (await memory(doris, db, send, res, url)) return true;
    if (await session(doris, db, send, res, url)) return true;
    if (await compare(doris, db, send, res, url)) return true;
    if (await sequences(doris, db, send, res, url)) return true;
    send(res, 404, { error: 'not found' });
    return true;
  }
  return { handle };
}
