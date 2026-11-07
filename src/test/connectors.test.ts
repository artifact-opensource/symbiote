import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBuiltinConnectors } from '../connectors/catalog.js';
import { ConnectorEngine } from '../connectors/engine.js';
import { McpConnectorAdapter } from '../connectors/mcp-adapter.js';
import { CredentialVault } from '../security/credential-vault.js';
import type { ToolDefinition } from '../tools/types.js';

function createVault(directory: string): CredentialVault {
  return new CredentialVault({
    adminEnvPath: path.join(directory, 'admin.env'),
    vaultPath: path.join(directory, 'integrations.enc'),
  });
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('connector engine stores credentials encrypted and enforces per-agent capability grants', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-connectors-'));
  const statePath = path.join(directory, 'connectors', 'state.json');
  const vault = createVault(directory);
  const requests: Array<{ url: URL; authorization?: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    return url.pathname === '/user'
      ? response({ login: 'test-owner' })
      : response({ total_count: 0, items: [] });
  };
  const engine = new ConnectorEngine({ vault, statePath });
  engine.registerMany(createBuiltinConnectors(fetcher));

  try {
    assert.equal(engine.list().length, 9);
    assert.deepEqual(
      engine.list().filter(entry => ['github', 'gitlab', 'gitee', 'bitbucket', 'codeberg'].includes(entry.manifest.id))
        .map(entry => entry.manifest.id),
      ['github', 'gitlab', 'gitee', 'bitbucket', 'codeberg'],
    );
    const connected = await engine.connect('github', { token: 'github-test-secret' });
    assert.equal(connected.connected, true);
    assert.equal(requests[0].url.pathname, '/user');
    assert.equal(requests[0].authorization, 'Bearer github-test-secret');
    assert.deepEqual(engine.allowedToolNames('main'), []);

    engine.setAgentCapabilities('main', 'github', ['search_repositories']);
    const allowed = engine.allowedToolNames('main');
    assert.deepEqual(allowed, ['connector_github_search_repositories']);

    const searchTool = engine.tools().find(tool => tool.name === 'connector_github_search_repositories');
    assert.ok(searchTool);
    await assert.rejects(
      searchTool.execute({ query: 'Symbiote' }, { agentId: 'unassigned-agent' }),
      /not authorized/,
    );
    const result = await searchTool.execute(
      { query: 'Symbiote', perPage: 10 },
      { agentId: 'main', sessionId: 'session-one' },
    );
    assert.deepEqual(JSON.parse(result), { total_count: 0, items: [] });
    assert.ok(engine.activity().some(item => item.capabilityId === 'search_repositories' && item.success));

    const persistedState = fs.readFileSync(statePath, 'utf8');
    assert.equal(persistedState.includes('github-test-secret'), false);
    assert.deepEqual(
      new ConnectorEngine({ vault, statePath }).getAgentCapabilities('main'),
      { github: ['search_repositories'] },
    );
    assert.throws(() => engine.setAgentCapabilities('main', 'github', ['delete_repository']), /not available/);

    await engine.disconnect('github');
    assert.equal(engine.list().find(entry => entry.manifest.id === 'github')?.connected, false);
    await assert.rejects(searchTool.execute({ query: 'Symbiote' }, { agentId: 'main' }), /not connected/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('connector marketplace discovers and restores credentials saved globally in the vault', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-connectors-global-'));
  const vault = createVault(directory);
  const requests: URL[] = [];
  const fetcher: typeof fetch = async input => {
    requests.push(input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url));
    return response({ username: 'owner' });
  };
  vault.set('connector:gitlab', { token: 'saved-gitlab-token' });
  const engine = new ConnectorEngine({ vault, statePath: path.join(directory, 'state.json') });
  engine.registerMany(createBuiltinConnectors(fetcher));

  try {
    const marketplaceEntry = engine.list().find(entry => entry.manifest.id === 'gitlab');
    assert.equal(marketplaceEntry?.configured, true);
    assert.equal(marketplaceEntry?.connected, false);

    await engine.restoreConnections();

    const restoredEntry = engine.list().find(entry => entry.manifest.id === 'gitlab');
    assert.equal(restoredEntry?.configured, true);
    assert.equal(restoredEntry?.connected, true);
    assert.equal(requests[0].pathname, '/api/v4/user');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Git hosting connectors use provider API authentication and repository endpoints', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-git-connectors-'));
  const vault = createVault(directory);
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    return response([]);
  };
  const engine = new ConnectorEngine({ vault, statePath: path.join(directory, 'state.json') });
  engine.registerMany(createBuiltinConnectors(fetcher));

  try {
    for (const id of ['gitlab', 'gitee', 'bitbucket', 'codeberg']) {
      await engine.connect(id, { token: `${id}-test-token` });
    }

    const gitlab = engine.tools().find(tool => tool.name === 'connector_gitlab_get_repository');
    const gitee = engine.tools().find(tool => tool.name === 'connector_gitee_get_repository');
    const bitbucket = engine.tools().find(tool => tool.name === 'connector_bitbucket_search_repositories');
    const codeberg = engine.tools().find(tool => tool.name === 'connector_codeberg_list_pull_requests');
    assert.ok(gitlab && gitee && bitbucket && codeberg);

    engine.setAgentCapabilities('main', 'gitlab', ['get_repository']);
    await gitlab.execute({ owner: 'group', repository: 'project' }, { agentId: 'main' });
    engine.setAgentCapabilities('main', 'gitee', ['get_repository']);
    await gitee.execute({ owner: 'owner', repository: 'repo' }, { agentId: 'main' });
    engine.setAgentCapabilities('main', 'bitbucket', ['search_repositories']);
    await bitbucket.execute({ owner: 'workspace', query: 'example' }, { agentId: 'main' });
    engine.setAgentCapabilities('main', 'codeberg', ['list_pull_requests']);
    await codeberg.execute({ owner: 'owner', repository: 'repo', state: 'open' }, { agentId: 'main' });

    assert.equal(requests.some(item => item.url.pathname === '/api/v4/projects/group%2Fproject'), true);
    assert.equal(requests.some(item => item.url.searchParams.get('access_token') === 'gitee-test-token'), true);
    assert.equal(requests.some(item => item.url.pathname === '/2.0/repositories/workspace'), true);
    assert.equal(requests.some(item => item.url.pathname === '/api/v1/repos/owner/repo/pulls'), true);
    assert.ok(requests.some(item => item.authorization === 'Bearer codeberg-test-token'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('connector health failures prevent saving credentials and surface provider errors', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-connectors-failed-'));
  const vault = createVault(directory);
  const fetcher: typeof fetch = async () => response({ ok: false, error: 'invalid_auth' });
  const engine = new ConnectorEngine({ vault, statePath: path.join(directory, 'state.json') });
  engine.registerMany(createBuiltinConnectors(fetcher));

  try {
    await assert.rejects(engine.connect('slack', { token: 'bad-token' }), /invalid_auth/);
    assert.equal(vault.has('connector:slack'), false);
    assert.equal(engine.list().find(entry => entry.manifest.id === 'slack')?.connected, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP connector preserves plain-text results and surfaces structured tool errors', async () => {
  const createTool = (name: string, result: string): ToolDefinition => ({
    name,
    description: `Test tool ${name}.`,
    parameters: { type: 'object', properties: {} },
    execute: async () => result,
  });
  let connected = true;
  const adapter = new McpConnectorAdapter('mcp-test-server', 'Test MCP Server', {
    connect: async () => { connected = true; },
    disconnect: () => { connected = false; },
    isConnected: () => connected,
    getTools: () => [
      createTool('plain text', 'The MCP tool completed successfully.'),
      createTool('structured error', '{"error":"The MCP tool rejected the request."}'),
    ],
  });
  const context = { agentId: 'main' };

  assert.equal(
    await adapter.execute('plain-text', {}, {}, context),
    'The MCP tool completed successfully.',
  );
  await assert.rejects(
    adapter.execute('structured-error', {}, {}, context),
    /The MCP tool rejected the request/,
  );
});
