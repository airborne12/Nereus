// The MCP endpoint of the trajectory tools (spec 7): the Streamable HTTP transport without a stream.
// Each POST carries one JSON-RPC message and is answered with one, or with 202 when it needs none.
// It is under /api, so it takes a session cookie or an API key like every other route.
//
//   POST /api/agents/mcp     one JSON-RPC message

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '../../control/auth/http.ts';
import type { Doris } from '../../db/doris.ts';
import { handleMessage } from '../mcp/protocol.ts';
import { trajectoryTools } from '../mcp/tools.ts';
import type { Send } from './request.ts';

export const MCP_PATH = '/api/agents/mcp';

/** Answers the MCP endpoint; false for any other path. */
export async function mcp(doris: Doris, db: string, send: Send, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== MCP_PATH) return false;
  if (req.method !== 'POST') {
    send(res, 405, { error: 'POST one JSON-RPC message to this endpoint; it offers no stream' }, { Allow: 'POST' });
    return true;
  }
  const answer = await handleMessage(await readJson(req), trajectoryTools(doris, db));
  if (!answer) {
    res.writeHead(202);
    res.end();
    return true;
  }
  send(res, 200, answer);
  return true;
}
