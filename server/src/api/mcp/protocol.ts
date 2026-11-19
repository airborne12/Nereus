// The Model Context Protocol of the trajectory tools (spec 7): one JSON-RPC 2.0 message in, one out,
// as the Streamable HTTP transport carries them. The server is stateless and offers tools only:
// the handshake, the list of tools, a call, and ping. A notification or a response gets no answer.

/** The versions of the protocol this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}
/** What a tool call answers: text for the model, and whether the tool failed. */
export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }
/** The tools offered; `call` answers null for a tool it does not have. */
export interface ToolSet { list: Tool[]; call: (name: string, args: Record<string, unknown>) => Promise<ToolResult | null> }

type Id = string | number | null;
interface Answer { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const SERVER = { name: 'nereus-trajectories', version: '1.0.0' };
const INSTRUCTIONS = "Read-only access to the agent trajectories Nereus keeps: search sessions, steps and messages, and read one session's turns, one turn or one step.";

const fail = (id: Id, code: number, message: string): Answer => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id: Id, result: unknown): Answer => ({ jsonrpc: '2.0', id, result });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The answer to one message; null when it needs none. */
export async function handleMessage(message: unknown, tools: ToolSet): Promise<Answer | null> {
  if (Array.isArray(message)) return fail(null, -32600, 'Send one message at a time');
  const m = obj(message);
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
  if (m.jsonrpc !== '2.0') return fail(id, -32600, 'Not a JSON-RPC 2.0 request');
  if (typeof m.method !== 'string') return null;
  if (!('id' in m)) return null;
  const params = obj(m.params);
  if (m.method === 'initialize') {
    const asked = String(params.protocolVersion ?? '');
    const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    return ok(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
  }
  if (m.method === 'ping') return ok(id, {});
  if (m.method === 'tools/list') return ok(id, { tools: tools.list });
  if (m.method === 'tools/call') {
    const name = String(params.name ?? '');
    const result = await tools.call(name, obj(params.arguments));
    return result ? ok(id, result) : fail(id, -32602, `Unknown tool: ${name}`);
  }
  return fail(id, -32601, `Method not found: ${m.method}`);
}
