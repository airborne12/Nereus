// The agent trajectory API (spec 7): read-only GET routes under /api/agents/. Every answer carries
// the statements that ran and the elapsed time. Query errors are CompileError and answer 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Doris } from '../../db/doris.ts';
import { compare } from './compare.ts';
import type { Send } from './request.ts';
import { session } from './session.ts';
import { tables } from './tables.ts';

export function agentRoutes(o: { doris: Doris; db: string; send: Send }) {
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/agents/') || req.method !== 'GET') return false;
    const { doris, db, send } = o;
    if (await tables(doris, db, send, res, url)) return true;
    if (await session(doris, db, send, res, url)) return true;
    if (await compare(doris, db, send, res, url)) return true;
    send(res, 404, { error: 'not found' });
    return true;
  }
  return { handle };
}
