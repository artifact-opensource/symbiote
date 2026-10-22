import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpMcpBridge } from '../tools/mcp-bridge.js';

test('HTTP MCP bridge initializes, discovers paginated tools, and carries session auth', async () => {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ body, headers });

    if (body.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'n8n', version: 'test' },
        },
      }), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' } });
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') {
      const params = body.params as { cursor?: string };
      if (params.cursor) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [] },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      const result = {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          nextCursor: 'page-2',
          tools: [{
            name: 'list_workflows',
            description: 'List workflows',
            inputSchema: {
              type: 'object',
              required: ['limit'],
              properties: {
                limit: { type: 'number', description: 'Maximum results' },
                filter: {
                  type: 'object',
                  properties: { active: { type: 'boolean' } },
                },
              },
            },
          }],
        },
      };
      return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (body.method === 'tools/call') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'workflow list' }] },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  };

  const bridge = new HttpMcpBridge({
    url: 'https://n8n.example.test/mcp-server/http',
    token: 'test-mcp-key',
    toolPrefix: 'n8n_mcp_',
    fetcher,
  });
  await bridge.connect();

  const [tool] = bridge.getTools();
  assert.equal(tool.name, 'n8n_mcp_list_workflows');
  assert.deepEqual(tool.parameters.required, ['limit']);
  assert.equal(tool.parameters.properties.filter.properties?.active.type, 'boolean');
  assert.equal(await tool.execute({ limit: 3 }), 'workflow list');

  assert.equal(requests.length, 5);
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer test-mcp-key');
  assert.equal(requests[1].headers.get('MCP-Protocol-Version'), '2025-03-26');
  assert.equal(requests[1].headers.get('Mcp-Session-Id'), 'session-1');
  assert.equal(requests[2].headers.get('Mcp-Session-Id'), 'session-1');
  assert.equal(requests[3].headers.get('Mcp-Session-Id'), 'session-1');
  assert.deepEqual(requests[3].body.params, { cursor: 'page-2' });
  assert.deepEqual(requests[4].body.params, { name: 'list_workflows', arguments: { limit: 3 } });
  bridge.disconnect();
  assert.equal(bridge.isConnected(), false);
});

test('HTTP MCP bridge rejects insecure remote endpoints and does not expose bearer tokens in auth errors', async () => {
  assert.throws(() => new HttpMcpBridge({
    url: 'http://n8n.example.test/mcp-server/http',
    token: 'hidden-token',
  }), /HTTPS/);
  assert.throws(() => new HttpMcpBridge({
    url: 'https://n8n.example.test/api/v1',
    token: 'hidden-token',
  }), /mcp-server\/http/);

  const bridge = new HttpMcpBridge({
    url: 'https://n8n.example.test/mcp-server/http',
    token: 'hidden-token',
    fetcher: async () => new Response(null, { status: 401 }),
  });
  await assert.rejects(bridge.connect(), error => {
    assert.match(String(error), /authorization failed/);
    assert.doesNotMatch(String(error), /hidden-token/);
    return true;
  });
});
