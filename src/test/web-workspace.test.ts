import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readWorkspaceIdentity, updateWorkspaceIdentity } from '../agent/workspace-identity.js';
import { createWorkspaceSessionManager, SessionManager } from '../sessions/manager.js';
import { createWorkspaceTaskTool } from '../tools/builtin/workspace-tasks.js';
import { startWebServer, type WebControlPlane } from '../web/server.js';

test('run metadata and colon-containing agent sessions survive a manager restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-workspace-run-'));
  try {
    const manager = new SessionManager(directory);
    const session = manager.create('subagent:persistent', { label: 'Persistent task' });
    session.metadata.webRuns = [{
      id: 'persistent',
      sessionId: session.id,
      name: 'Persistent task',
      prompt: 'Inspect the workspace.',
      status: 'completed',
      startedAt: 100,
      completedAt: 200,
      result: 'Workspace inspected.',
      toolNames: ['read'],
    }];
    manager.save(session);

    assert.deepEqual(new SessionManager(directory).load(session.id)?.metadata.webRuns, session.metadata.webRuns);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workspace APIs validate tasks and expose real run and agent controls', async () => {
  const started: Array<{ name?: string; prompt: string; sessionId: string }> = [];
  const controlled: Array<{ id: string; action: 'stop' | 'steer'; message?: string }> = [];
  const guided: Array<{ id: string; message: string }> = [];
  const identityUpdates: Array<{ name: string; emoji: string; soulContent: string; agentsContent: string; instructions: string }> = [];
  const browserActions: Array<{ action: string; params: Record<string, unknown> }> = [];
  let browserUrl = 'https://example.com/';
  let chessState: Record<string, unknown> | null = null;
  let stoppedRun = '';
  const control: WebControlPlane = {
    getStatus: () => ({}),
    getConfig: () => ({}),
    getSessions: () => [],
    getSessionMessages: () => [],
    createSession: () => ({}),
    hasSession: id => id === 'web-session',
    archiveSession: id => id === 'web-session',
    getTools: () => [],
    chat: async (_request, emit) => {
      emit?.({ type: 'text_delta', text: 'Hello' });
      return { text: 'Hello' };
    },
    interruptSession: id => id === 'web-session',
    getRuns: () => [{ id: 'run-1', status: 'running' }],
    startRun: request => {
      started.push(request);
      return { id: 'run-2', ...request, status: 'running' };
    },
    stopRun: id => {
      stoppedRun = id;
      return true;
    },
    restartRun: id => id === 'run-1' ? { id: 'run-3', status: 'running' } : null,
    guideRun: (id, message) => {
      guided.push({ id, message });
      return { id: 'run-4', status: 'running' };
    },
    updateIdentity: identity => {
      identityUpdates.push(identity);
      return identity;
    },
    getAgents: () => [{ sessionId: 'subagent:one', status: 'running' }],
    getMemoryGraph: () => ({ stats: { documentCount: 1 }, nodes: [{ id: 'memory-1' }], edges: [] }),
    getMemoryDocument: id => id === 'memory-1' ? { id, text: 'indexed memory' } : null,
    browserNavigate: async url => {
      browserUrl = url;
      return { url, title: 'Example' };
    },
    browserCapture: async () => ({ url: browserUrl, title: 'Example', viewport: { width: 1280, height: 720 }, image: 'data:image/jpeg;base64,ZmFrZQ==' }),
    browserControl: async (action, params) => {
      browserActions.push({ action, params });
    },
    getChessState: () => chessState,
    saveChessState: state => {
      chessState = state;
      return state;
    },
    controlAgent: (id, action, message) => {
      controlled.push({ id, action, message });
      return true;
    },
    webAccessToken: 'test-lan-access-token-with-more-than-32-characters',
    logPath: '',
  };
  const server = startWebServer(0, '127.0.0.1', control);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const lanToken = await fetch(`${baseUrl}/api/access/token`);
    assert.equal(lanToken.status, 200);
    assert.equal((await lanToken.json() as { token: string }).token, control.webAccessToken);
    assert.equal(lanToken.headers.get('cache-control'), 'no-store');
    const crossOriginToken = await fetch(`${baseUrl}/api/access/token`, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(crossOriginToken.status, 403);

    const memoryGraph = await fetch(`${baseUrl}/api/memory/graph`);
    assert.equal(memoryGraph.status, 200);
    assert.deepEqual((await memoryGraph.json() as { nodes: unknown[] }).nodes, [{ id: 'memory-1' }]);
    const memoryDocument = await fetch(`${baseUrl}/api/memory/documents/memory-1`);
    assert.equal(memoryDocument.status, 200);
    assert.deepEqual(await memoryDocument.json(), { id: 'memory-1', text: 'indexed memory' });

    const browserSnapshot = await fetch(`${baseUrl}/api/browser/snapshot`);
    assert.equal(browserSnapshot.status, 200);
    assert.equal((await browserSnapshot.json() as { title: string }).title, 'Example');
    const invalidBrowserUrl = await fetch(`${baseUrl}/api/browser/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });
    assert.equal(invalidBrowserUrl.status, 400);
    const navigateBrowser = await fetch(`${baseUrl}/api/browser/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'example.org/path' }),
    });
    assert.equal(navigateBrowser.status, 200);
    assert.equal((await navigateBrowser.json() as { url: string }).url, 'https://example.org/path');
    const browserAction = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'click', x: 24, y: 56 }),
    });
    assert.equal(browserAction.status, 200);
    assert.deepEqual(browserActions, [{ action: 'click', params: { x: 24, y: 56 } }]);

    const chessStateValue = {
      version: 1,
      score: { rating: 1000, wins: 0, losses: 0, draws: 0 },
      difficulty: 'adaptive',
      fen: 'start',
      pgn: '',
      result: null,
      history: [],
      updatedAt: 123,
    };
    const saveChessState = await fetch(`${baseUrl}/api/games/chess`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: chessStateValue }),
    });
    assert.equal(saveChessState.status, 200);
    assert.deepEqual((await saveChessState.json() as { state: unknown }).state, chessStateValue);
    const loadChessState = await fetch(`${baseUrl}/api/games/chess`);
    assert.deepEqual((await loadChessState.json() as { state: unknown }).state, chessStateValue);
    const invalidChessState = await fetch(`${baseUrl}/api/games/chess`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { ...chessStateValue, fen: 400 } }),
    });
    assert.equal(invalidChessState.status, 400);

    const chatResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', sessionId: 'web-session' }),
    });
    assert.equal(chatResponse.status, 200);
    assert.match(chatResponse.headers.get('content-type') || '', /text\/event-stream/);
    const chatEvents = await chatResponse.text();
    assert.match(chatEvents, /"type":"text_delta","text":"Hello"/);
    assert.match(chatEvents, /"type":"done"/);

    const interruptResponse = await fetch(`${baseUrl}/api/sessions/web-session/interrupt`, { method: 'POST' });
    assert.equal(interruptResponse.status, 200);
    assert.deepEqual(await interruptResponse.json(), { interrupted: true });

    const runsResponse = await fetch(`${baseUrl}/api/runs`);
    assert.equal(runsResponse.status, 200);
    assert.deepEqual(await runsResponse.json(), [{ id: 'run-1', status: 'running' }]);

    const invalidTask = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '  ' }),
    });
    assert.equal(invalidTask.status, 400);

    const longTask = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x'.repeat(20_001) }),
    });
    assert.equal(longTask.status, 413);

    const startedRun = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  API review  ', prompt: '  Review the API.  ', sessionId: 'web-session' }),
    });
    assert.equal(startedRun.status, 201);
    assert.deepEqual(started[0], { name: 'API review', prompt: 'Review the API.', sessionId: 'web-session' });

    const archiveResponse = await fetch(`${baseUrl}/api/sessions/web-session`, { method: 'DELETE' });
    assert.equal(archiveResponse.status, 200);
    assert.deepEqual(await archiveResponse.json(), { archived: true });

    const stopResponse = await fetch(`${baseUrl}/api/runs/run-2/stop`, { method: 'POST' });
    assert.equal(stopResponse.status, 200);
    assert.equal(stoppedRun, 'run-2');

    const restartResponse = await fetch(`${baseUrl}/api/runs/run-1/restart`, { method: 'POST' });
    assert.equal(restartResponse.status, 201);
    assert.deepEqual(await restartResponse.json(), { id: 'run-3', status: 'running' });

    const guideResponse = await fetch(`${baseUrl}/api/runs/run-1/guide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '  Check the failing test.  ' }),
    });
    assert.equal(guideResponse.status, 202);
    assert.deepEqual(guided, [{ id: 'run-1', message: 'Check the failing test.' }]);

    const identityResponse = await fetch(`${baseUrl}/api/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Pathfinder  ', emoji: '🧭', soulContent: '# Soul\n- Name: old', agentsContent: '# Rules\n- Name: old', instructions: 'Be precise.' }),
    });
    assert.equal(identityResponse.status, 200);
    assert.deepEqual(identityUpdates, [{
      name: 'Pathfinder',
      emoji: '🧭',
      soulContent: '# Soul\n- Name: old',
      agentsContent: '# Rules\n- Name: old',
      instructions: 'Be precise.',
    }]);

    const agentsResponse = await fetch(`${baseUrl}/api/agents`);
    assert.equal(agentsResponse.status, 200);
    assert.deepEqual(await agentsResponse.json(), [{ sessionId: 'subagent:one', status: 'running' }]);

    const invalidSteer = await fetch(`${baseUrl}/api/agents/subagent%3Aone/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'steer', message: '  ' }),
    });
    assert.equal(invalidSteer.status, 400);

    const steerResponse = await fetch(`${baseUrl}/api/agents/subagent%3Aone/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'steer', message: '  Focus on test coverage.  ' }),
    });
    assert.equal(steerResponse.status, 200);
    assert.deepEqual(controlled, [{ id: 'subagent:one', action: 'steer', message: 'Focus on test coverage.' }]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('main-agent workspace task tool can list and control Kanban runs', async () => {
  const actions: Array<{ action: string; id?: string; message?: string }> = [];
  const tool = createWorkspaceTaskTool({
    listRuns: () => [{ id: 'run-1', status: 'running' }],
    stopRun: id => { actions.push({ action: 'stop', id }); return true; },
    restartRun: id => { actions.push({ action: 'restart', id }); return { id: 'run-2', status: 'running' }; },
    guideRun: (id, message) => { actions.push({ action: 'guide', id, message }); return { id: 'run-3', status: 'running' }; },
  });

  assert.deepEqual(JSON.parse(await tool.execute({ action: 'list' })), [{ id: 'run-1', status: 'running' }]);
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'guide', runId: 'run-1', message: '  Continue with tests.  ' })), { id: 'run-3', status: 'running' });
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'restart', runId: 'run-1' })), { id: 'run-2', status: 'running' });
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'stop', runId: 'run-1' })), { stopped: true, runId: 'run-1' });
  assert.deepEqual(actions, [
    { action: 'guide', id: 'run-1', message: 'Continue with tests.' },
    { action: 'restart', id: 'run-1' },
    { action: 'stop', id: 'run-1' },
  ]);
  await assert.rejects(tool.execute({ action: 'guide', runId: 'run-1', message: '  ' }), /non-empty message/);
});

test('workspace identity reads its name from AGENTS.md and updates it with identity settings', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-workspace-identity-'));
  try {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent rules\n\n- Name: File Agent\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# Soul\n\n- Name: Persona Agent\n- Emoji: 🌿\n', 'utf8');
    assert.equal(readWorkspaceIdentity(workspace).agentName, 'File Agent');

    const updated = updateWorkspaceIdentity(workspace, {
      name: 'New Agent',
      emoji: '🧭',
      soulContent: '# Soul\n- Name: File Agent\n\nChanged character.\n',
      agentsContent: '# Rules\n- Name: File Agent\n\nChanged protocol.\n',
      instructions: '',
    });
    assert.equal(updated.agentName, 'New Agent');
    assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), '# Rules\n- Name: New Agent\n\nChanged protocol.\n');
    assert.equal(fs.readFileSync(path.join(workspace, 'SOUL.md'), 'utf8'), '# Soul\n- Name: New Agent\n\nChanged character.\n- Emoji: 🧭\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('workspace sessions migrate to .session and archived conversations leave active listings', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-migration-'));
  const legacy = path.join(workspace, '.sessions');
  fs.mkdirSync(path.join(legacy, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'web-conversation.json'), JSON.stringify({
    id: 'web-conversation',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    metadata: { label: 'Conversation', messageCount: 0, tokenUsage: { input: 0, output: 0 }, toolsUsed: {}, depth: 0 },
  }));
  fs.writeFileSync(path.join(legacy, 'archive', 'old-transcript.json'), '{"messages":[]}');
  try {
    const manager = createWorkspaceSessionManager(workspace, legacy);
    assert.equal(manager.directory, path.join(workspace, '.session'));
    assert.equal(fs.existsSync(path.join(legacy, 'web-conversation.json')), false);
    assert.equal(fs.existsSync(path.join(manager.directory, 'archive', 'old-transcript.json')), true);
    assert.equal(manager.list().length, 1);
    assert.equal(manager.archiveSession('web-conversation'), true);
    assert.equal(manager.list().length, 0);
    assert.equal(fs.existsSync(path.join(manager.directory, 'archive', 'web-conversation.json')), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
