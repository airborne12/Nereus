// The MCP protocol of the trajectory tools, as one JSON-RPC message in and one out: the handshake,
// the list of tools, a call, and what a notification or a wrong message gets.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMessage, PROTOCOL_VERSIONS, type ToolSet } from '../src/api/mcp/protocol.ts';

const tools: ToolSet = {
  list: [{ name: 'echo', title: 'Echo', description: 'Says it back.', inputSchema: { type: 'object', properties: { said: { type: 'string' } }, required: ['said'] }, annotations: { readOnlyHint: true } }],
  call: async (name, args) => (name === 'echo' ? { content: [{ type: 'text', text: String(args.said) }] } : null),
};
const ask = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => handleMessage({ jsonrpc: '2.0', id, method, params }, tools);

test('the handshake answers the version the client asked for when it is known, else the newest, and says the server has tools', async () => {
  const got = await ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } });
  assert.deepEqual(got, {
    jsonrpc: '2.0', id: 1,
    result: {
      protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nereus-trajectories', version: '1.0.0' },
      instructions: 'Read-only access to the agent trajectories Nereus keeps: search sessions, steps and messages, and read one session\'s turns, one turn or one step.',
    },
  });
  const newer = await ask('initialize', { protocolVersion: '2099-01-01' });
  assert.equal((newer as { result: { protocolVersion: string } }).result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('the tools are listed, and a call answers what the tool answers', async () => {
  assert.deepEqual(await ask('tools/list'), { jsonrpc: '2.0', id: 1, result: { tools: tools.list } });
  assert.deepEqual(await ask('tools/call', { name: 'echo', arguments: { said: 'hi' } }, 'x'), { jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: 'hi' }] } });
  assert.deepEqual(await ask('ping'), { jsonrpc: '2.0', id: 1, result: {} });
});

test('an unknown tool, an unknown method and a message that is not a request are errors; a notification gets no answer', async () => {
  assert.deepEqual(await ask('tools/call', { name: 'nope', arguments: {} }), { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool: nope' } });
  assert.deepEqual(await ask('resources/list'), { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: resources/list' } });
  assert.deepEqual(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools), null);
  assert.deepEqual(await handleMessage({ jsonrpc: '2.0', id: 3, result: {} }, tools), null, 'a response from the client gets none');
  assert.deepEqual(await handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], tools), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one message at a time' } });
  assert.deepEqual(await handleMessage({ id: 1, method: 'ping' }, tools), { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Not a JSON-RPC 2.0 request' } });
});
