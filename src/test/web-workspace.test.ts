import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readWorkspaceIdentity, updateWorkspaceIdentity } from '../agent/workspace-identity.js';
import { createWorkspaceSessionManager, SessionManager } from '../sessions/manager.js';
import { createWorkspaceTaskTool } from '../tools/builtin/workspace-tasks.js';
import { validateAppearanceSettings, type AppearanceSettings } from '../appearance/settings.js';
import { startWebServer, type WebControlPlane } from '../web/server.js';
import type { AgentThread, ThreadContact } from '../threads/manager.js';

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
  const started: Array<{ name?: string; prompt: string; sessionId: string; trustedAdminContext?: boolean }> = [];
  const chatAdminContexts: boolean[] = [];
  const controlled: Array<{ id: string; action: 'stop' | 'steer'; message?: string }> = [];
  const guided: Array<{ id: string; message: string }> = [];
  const identityUpdates: Array<{ name: string; emoji: string; soulContent: string; agentsContent: string; instructions: string }> = [];
  const browserActions: Array<{ action: string; params: Record<string, unknown> }> = [];
  let browserUrl = 'https://example.com/';
  let chessState: Record<string, unknown> | null = null;
  let stoppedRun = '';
  let archivedRun = '';
  let restoredRun = '';
  let configuredProvider = '';
  let includedArchivedProjects = false;
  let integrationTests = 0;
  let updateCheckCalls = 0;
  let defaultAgentPrompt = 'test prompt';
  let appearanceSettings: AppearanceSettings = { brightness: 64, primaryHue: 145, secondaryHue: 13 };
  let updatePrepareCalls = 0;
  let restartRequests = 0;
  let tailscaleEnabled = false;
  let updatedProviderModel: { provider: string; model: string } | undefined;
  let clonedRepository = '';
  let cloneRepositoryCalls = 0;
  const updateDownload = {
    state: 'ready' as const,
    version: '5.6.0',
    filename: 'Symbiote-5.6.0-x64.msi',
    sha256: 'a'.repeat(64),
  };
  const updateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-update-api-'));
  const updateInstallerPath = path.join(updateDirectory, updateDownload.filename);
  fs.writeFileSync(updateInstallerPath, 'verified MSI');
  const control: WebControlPlane = {
    getStatus: () => ({}),
    restartGateway: () => { restartRequests++; },
    getTailscaleStatus: async () => ({
      connected: true,
      ip: '100.90.0.1',
      enabled: tailscaleEnabled,
      mode: tailscaleEnabled ? 'tailscale' : 'lan',
      accessUrl: `http://${tailscaleEnabled ? '100.90.0.1' : '192.168.1.10'}:3009`,
    }),
    setTailscaleAccess: async enabled => {
      tailscaleEnabled = enabled;
      return {
        connected: true,
        ip: '100.90.0.1',
        enabled,
        mode: enabled ? 'tailscale' : 'lan',
        accessUrl: `http://${enabled ? '100.90.0.1' : '192.168.1.10'}:3009`,
      };
    },
    updateProviderModel: (provider, model) => updatedProviderModel = { provider, model },
    cloneProjectRepository: async repositoryUrl => {
      cloneRepositoryCalls++;
      clonedRepository = repositoryUrl;
      return { id: 'project-clone', name: 'example' };
    },
    getUpdateDownload: () => updateDownload,
    refreshUpdateStatus: async () => {
      updateCheckCalls++;
      return {
        state: 'current' as const,
        currentVersion: '5.6.2',
        latestVersion: '5.6.2',
        checkedAt: 123,
      };
    },
    prepareUpdateDownload: async () => {
      updatePrepareCalls++;
      return updateDownload;
    },
    getUpdateInstallerPath: () => updateInstallerPath,
    getConfig: () => ({}),
    getAppearanceSettings: () => ({ settings: appearanceSettings, initialized: true }),
    updateAppearanceSettings: settings => appearanceSettings = validateAppearanceSettings(settings),
    getSessions: () => [],
    getSessionMessages: () => [],
    createSession: () => ({}),
    getProjects: includeArchived => { includedArchivedProjects = includeArchived === true; return []; },
    archiveProject: projectId => ({ id: projectId, archivedAt: 1 }),
    restoreProject: projectId => ({ id: projectId, name: 'Research' }),
    updateProject: (projectId, patch) => ({ id: projectId, name: patch.name ?? 'Research', scope: patch.scope ?? '' }),
    deleteArchivedProject: projectId => projectId === 'project-1',
    getProjectFiles: () => [],
    getProjectStorage: () => ({ fileCount: 0, directoryCount: 0, bytes: 0 }),
    readProjectFile: (projectId, filePath) => {
      if (filePath.includes('..')) throw new Error('Project file path is invalid or reserved.');
      return { projectId, path: filePath, content: '' };
    },
    createProjectFile: (projectId, filePath, content) => ({ projectId, path: filePath, size: Buffer.byteLength(content) }),
    createProjectDirectory: (projectId, filePath) => ({ projectId, path: filePath }),
    moveProjectEntry: (_projectId, _source, destination) => ({ path: destination }),
    deleteProjectEntry: () => true,
    writeProjectFile: (projectId, filePath, content) => ({ projectId, path: filePath, size: Buffer.byteLength(content) }),
    deleteProjectFile: () => true,
    runProjectCommand: async (_projectId, command, timeout) => `${timeout}s: ${command}`,
    startProjectTerminal: () => ({ terminalId: 'terminal-1', pid: 123 }),
    writeProjectTerminal: () => {},
    pollProjectTerminal: () => ({ output: '', running: true, exitCode: null, truncated: false }),
    killProjectTerminal: async () => true,
    getProjectTasks: () => [],
    addProjectTask: (_projectId, title, description) => ({ id: 'task-1', title, description: description ?? '', status: 'pending', createdAt: 1, updatedAt: 1 }),
    updateProjectTask: (_projectId, id, patch) => ({ id, title: patch.title ?? 'Task', description: patch.description ?? '', status: patch.status ?? 'pending', createdAt: 1, updatedAt: 2 }),
    deleteProjectTask: () => true,
    getWorkspaceAgents: () => [],
    createProject: name => ({ id: 'project-1', name }),
    createWorkspaceAgent: input => ({ id: 'agent-1', ...input }),
    hasSession: id => id === 'web-session',
    archiveSession: id => id === 'web-session' || id === 'subagent:completed',
    getTools: () => [],
    getIntegrationStatus: () => ({
      azure: configuredProvider === 'azure',
      oci: configuredProvider === 'oci',
      n8n: configuredProvider === 'n8n',
      kaggle: configuredProvider === 'kaggle',
    }),
    saveIntegrationCredentials: provider => { configuredProvider = provider; },
    deleteIntegrationCredentials: provider => { if (configuredProvider === provider) configuredProvider = ''; },
    testIntegration: async () => { integrationTests++; },
    getCronState: () => ({ jobs: [], alerts: [], systemPrompt: defaultAgentPrompt }),
    createCronJob: input => ({ id: 'cron-1', ...input, enabled: input.enabled !== false, createdAt: 1, updatedAt: 1, nextRunAt: 2, runCount: 0 }),
    updateCronJob: (id, patch) => ({
      id, name: patch.name ?? 'test', prompt: patch.prompt ?? 'test',
      schedule: patch.schedule ?? { type: 'cron', expression: '0 9 * * *' },
      enabled: patch.enabled ?? true, createdAt: 1, updatedAt: 1, nextRunAt: 2, runCount: 0,
    }),
    deleteCronJob: () => true,
    retryCronAlert: id => ({ id, jobId: 'cron-1', jobName: 'test', prompt: 'test', scheduledAt: 1, createdAt: 1, status: 'pending', attempts: 1 }),
    updateDefaultAgentPrompt: systemPrompt => { defaultAgentPrompt = systemPrompt; return systemPrompt; },
    getThreads: () => [],
    getUnreadThreadRequests: () => [{ id: 'thread-1:post-1', threadId: 'thread-1', postId: 'post-1', title: 'Need help', body: 'Blocked', createdAt: 2 }],
    createThread: input => ({
      id: 'thread-1',
      title: input.title,
      scope: input.scope,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      participants: input.participants ?? [],
      externalContactIds: input.externalContactIds ?? [],
      createdBy: { type: 'user', id: 'user' },
      createdAt: 1,
      updatedAt: 1,
      posts: [],
    } satisfies AgentThread),
    postThreadMessage: id => ({
      id, title: 'Thread', scope: 'open', participants: [], externalContactIds: [],
      createdBy: { type: 'user', id: 'user' }, createdAt: 1, updatedAt: 2,
      posts: [{ id: 'post-1', author: { type: 'user', id: 'user' }, body: 'Hello', mentions: [], createdAt: 2 }],
    }),
    markThreadRead: id => ({ id, title: 'Thread', scope: 'open', participants: [], externalContactIds: [], createdBy: { type: 'user', id: 'user' }, createdAt: 1, updatedAt: 2, posts: [] }),
    reactToThreadPost: id => ({ id, title: 'Thread', scope: 'open', participants: [], externalContactIds: [], createdBy: { type: 'user', id: 'user' }, createdAt: 1, updatedAt: 2, posts: [] }),
    archiveThread: () => true,
    createThreadContact: label => ({ id: 'contact-1', label, createdAt: 1, token: 'one-time-secret' }),
    getThreadContacts: (): Array<Omit<ThreadContact, 'tokenHash' | 'postTimes'>> => [],
    deleteThreadContact: () => true,
    authenticateThreadContact: token => token === 'external-secret' ? { id: 'contact-1', label: 'Build bot' } : undefined,
    createExternalThread: (_contact, title) => ({
      id: 'thread-external', title, scope: 'external', participants: ['main'], externalContactIds: ['contact-1'],
      createdBy: { type: 'user', id: 'user' }, createdAt: 1, updatedAt: 2,
      posts: [{ id: 'post-external', author: { type: 'external', id: 'contact-1' }, body: 'Build complete', mentions: [], createdAt: 2 }],
    }),
    getExternalThreads: () => [],
    getExternalThread: () => undefined,
    postExternalThreadMessage: (_contact, id) => ({
      id, title: 'Thread', scope: 'external', participants: ['main'], externalContactIds: ['contact-1'],
      createdBy: { type: 'user', id: 'user' }, createdAt: 1, updatedAt: 2,
      posts: [{ id: 'post-external', author: { type: 'external', id: 'contact-1' }, body: 'Follow up', mentions: [], createdAt: 2 }],
    }),
    retryThreadNotification: id => ({ id, status: 'pending' }),
    chat: async (request, emit) => {
      chatAdminContexts.push(request.trustedAdminContext === true);
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
    archiveRun: id => {
      archivedRun = id;
      return true;
    },
    restoreRun: id => {
      restoredRun = id;
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
    const rejectedRestart = await fetch(`${baseUrl}/api/gateway/restart`, {
      method: 'POST',
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(rejectedRestart.status, 403);
    const restartResponse = await fetch(`${baseUrl}/api/gateway/restart`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    assert.equal(restartResponse.status, 202);
    assert.deepEqual(await restartResponse.json(), { restarting: true });
    assert.equal(restartRequests, 1);

    const tailscaleStatus = await fetch(`${baseUrl}/api/integrations/tailscale`);
    assert.equal(tailscaleStatus.status, 200);
    assert.equal(tailscaleStatus.headers.get('cache-control'), 'no-store');
    assert.equal((await tailscaleStatus.json()).mode, 'lan');
    const rejectedTailscaleChange = await fetch(`${baseUrl}/api/integrations/tailscale`, {
      method: 'PUT',
      headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(rejectedTailscaleChange.status, 403);
    const tailscaleChange = await fetch(`${baseUrl}/api/integrations/tailscale`, {
      method: 'PUT',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(tailscaleChange.status, 200);
    assert.equal((await tailscaleChange.json()).mode, 'tailscale');
    assert.equal(tailscaleEnabled, true);
    const tailscaleRestart = await fetch(`${baseUrl}/api/integrations/tailscale/restart`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    assert.equal(tailscaleRestart.status, 202);
    assert.equal(restartRequests, 2);

    const updatedRoute = await fetch(`${baseUrl}/api/config/provider-model`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: 'openrouter/free' }),
    });
    assert.deepEqual(await updatedRoute.json(), { provider: 'openrouter', model: 'openrouter/free' });
    assert.deepEqual(updatedProviderModel, { provider: 'openrouter', model: 'openrouter/free' });
    const invalidRoute = await fetch(`${baseUrl}/api/config/provider-model`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: 'invalid\nmodel' }),
    });
    assert.equal(invalidRoute.status, 400);

    const clonedProject = await fetch(`${baseUrl}/api/projects/clone`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/example/example.git' }),
    });
    assert.equal(clonedProject.status, 201);
    assert.deepEqual(await clonedProject.json(), { id: 'project-clone', name: 'example' });
    assert.equal(clonedRepository, 'https://github.com/example/example.git');
    const rejectedClone = await fetch(`${baseUrl}/api/projects/clone`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    assert.equal(rejectedClone.status, 400);
    assert.equal(cloneRepositoryCalls, 1);
    const rejectedCredentialClone = await fetch(`${baseUrl}/api/projects/clone`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://user:password@example.com/repository.git' }),
    });
    assert.equal(rejectedCredentialClone.status, 400);
    assert.equal(cloneRepositoryCalls, 1);

    const checkedUpdate = await fetch(`${baseUrl}/api/update/check`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    assert.equal(checkedUpdate.status, 200);
    assert.equal(checkedUpdate.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await checkedUpdate.json(), {
      state: 'current',
      currentVersion: '5.6.2',
      latestVersion: '5.6.2',
      checkedAt: 123,
    });
    assert.equal(updateCheckCalls, 1);
    const rejectedUpdateCheckOrigin = await fetch(`${baseUrl}/api/update/check`, {
      method: 'POST',
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(rejectedUpdateCheckOrigin.status, 403);

    const preparedUpdate = await fetch(`${baseUrl}/api/update/download`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    assert.equal(preparedUpdate.status, 201);
    assert.deepEqual(await preparedUpdate.json(), updateDownload);
    assert.equal(updatePrepareCalls, 1);
    const rejectedUpdateOrigin = await fetch(`${baseUrl}/api/update/download`, {
      method: 'POST',
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(rejectedUpdateOrigin.status, 403);
    const installerDownload = await fetch(`${baseUrl}/api/update/installer`, {
      headers: { origin: baseUrl },
    });
    assert.equal(installerDownload.status, 200);
    assert.equal(installerDownload.headers.get('content-disposition'), 'attachment; filename="Symbiote-5.6.0-x64.msi"');
    assert.equal(await installerDownload.text(), 'verified MSI');

    const lanToken = await fetch(`${baseUrl}/api/access/token`);
    assert.equal(lanToken.status, 200);
    assert.equal((await lanToken.json() as { token: string }).token, control.webAccessToken);
    assert.equal(lanToken.headers.get('cache-control'), 'no-store');
    const crossOriginToken = await fetch(`${baseUrl}/api/access/token`, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(crossOriginToken.status, 403);

    const appearanceResponse = await fetch(`${baseUrl}/api/appearance`);
    assert.equal(appearanceResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await appearanceResponse.json(), { settings: appearanceSettings, initialized: true });
    const savedAppearance = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brightness: 0, primaryHue: 280, secondaryHue: 42 }),
    });
    assert.deepEqual(await savedAppearance.json(), { settings: { brightness: 0, primaryHue: 280, secondaryHue: 42 }, initialized: true });
    assert.deepEqual(appearanceSettings, { brightness: 0, primaryHue: 280, secondaryHue: 42 });
    const invalidAppearance = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brightness: 101, primaryHue: 280, secondaryHue: 42 }),
    });
    assert.equal(invalidAppearance.status, 400);

    const integrationStatus = await fetch(`${baseUrl}/api/integrations`);
    assert.deepEqual(await integrationStatus.json(), {
      providers: { azure: false, oci: false, n8n: false, kaggle: false },
    });
    const cronState = await fetch(`${baseUrl}/api/cron`);
    assert.equal(cronState.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await cronState.json(), { jobs: [], alerts: [], systemPrompt: 'test prompt' });
    const createdCronJob = await fetch(`${baseUrl}/api/cron/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Morning check', prompt: 'Review the queue.', schedule: { type: 'cron', expression: '0 9 * * 1-5' } }),
    });
    assert.equal(createdCronJob.status, 201);
    assert.equal((await createdCronJob.json() as { id: string }).id, 'cron-1');
    const updatedCronJob = await fetch(`${baseUrl}/api/cron/jobs/cron-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal((await updatedCronJob.json() as { enabled: boolean }).enabled, false);
    const retriedAlert = await fetch(`${baseUrl}/api/cron/alerts/alert-1/retry`, { method: 'POST' });
    assert.equal(retriedAlert.status, 200);
    const savedCronPrompt = await fetch(`${baseUrl}/api/cron/default-prompt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'Updated operations prompt.' }),
    });
    assert.deepEqual(await savedCronPrompt.json(), { systemPrompt: 'Updated operations prompt.' });
    assert.equal(defaultAgentPrompt, 'Updated operations prompt.');
    const listedThreads = await fetch(`${baseUrl}/api/threads`);
    assert.deepEqual(await listedThreads.json(), []);
    const userHelpRequests = await fetch(`${baseUrl}/api/threads/requests`);
    assert.equal((await userHelpRequests.json() as Array<{ title: string }>)[0].title, 'Need help');
    const markThreadRead = await fetch(`${baseUrl}/api/threads/thread-1/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: 'post-1' }),
    });
    assert.equal(markThreadRead.status, 200);
    const addThreadReaction = await fetch(`${baseUrl}/api/threads/thread-1/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: 'post-1', emoji: '✅' }),
    });
    assert.equal(addThreadReaction.status, 200);
    const externalUnauthorized = await fetch(`${baseUrl}/api/external/threads`);
    assert.equal(externalUnauthorized.status, 401);
    const externalCreated = await fetch(`${baseUrl}/api/external/threads`, {
      method: 'POST',
      headers: { authorization: 'Bearer external-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'CI result', body: 'Build succeeded.' }),
    });
    assert.equal(externalCreated.status, 201);
    assert.equal((await externalCreated.json() as { scope: string }).scope, 'external');
    const listedExternalThreads = await fetch(`${baseUrl}/api/external/threads`, {
      headers: { authorization: 'Bearer external-secret' },
    });
    assert.equal(listedExternalThreads.status, 200);
    const deletedCronJob = await fetch(`${baseUrl}/api/cron/jobs/cron-1`, { method: 'DELETE' });
    assert.deepEqual(await deletedCronJob.json(), { deleted: true });
    const createdProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Research' }),
    });
    assert.equal(createdProject.status, 201);
    assert.deepEqual(await createdProject.json(), { id: 'project-1', name: 'Research' });
    const updatedProject = await fetch(`${baseUrl}/api/projects/project-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Research revamp', scope: 'Ship a documented product.' }),
    });
    assert.equal(updatedProject.status, 200);
    assert.deepEqual(await updatedProject.json(), { id: 'project-1', name: 'Research revamp', scope: 'Ship a documented product.' });
    const archivedProject = await fetch(`${baseUrl}/api/projects/project-1`, { method: 'DELETE' });
    assert.deepEqual(await archivedProject.json(), { id: 'project-1', archivedAt: 1 });
    const archivedProjects = await fetch(`${baseUrl}/api/projects?includeArchived=true`);
    assert.deepEqual(await archivedProjects.json(), []);
    assert.equal(includedArchivedProjects, true);
    const restoredProject = await fetch(`${baseUrl}/api/projects/project-1/restore`, { method: 'POST' });
    assert.deepEqual(await restoredProject.json(), { id: 'project-1', name: 'Research' });
    const permanentDelete = await fetch(`${baseUrl}/api/projects/project-1/permanent`, { method: 'DELETE' });
    assert.deepEqual(await permanentDelete.json(), { deleted: true });
    const projectFiles = await fetch(`${baseUrl}/api/projects/project-1/files`);
    assert.deepEqual(await projectFiles.json(), []);
    const openedProjectFile = await fetch(`${baseUrl}/api/projects/project-1/file?path=src%2Findex.ts`);
    assert.equal(openedProjectFile.status, 200);
    assert.deepEqual(await openedProjectFile.json(), { projectId: 'project-1', path: 'src/index.ts', content: '' });
    const createdProjectFile = await fetch(`${baseUrl}/api/projects/project-1/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/index.ts', content: 'export {};' }),
    });
    assert.equal(createdProjectFile.status, 201);
    const savedProjectFile = await fetch(`${baseUrl}/api/projects/project-1/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/index.ts', content: 'export const value = 1;' }),
    });
    assert.equal(savedProjectFile.status, 200);
    const largeProjectFile = await fetch(`${baseUrl}/api/projects/project-1/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'data/large.json', content: 'x'.repeat(1_250_000) }),
    });
    assert.equal(largeProjectFile.status, 201);
    assert.equal((await largeProjectFile.json() as { size: number }).size, 1_250_000);
    const deletedProjectFile = await fetch(`${baseUrl}/api/projects/project-1/file`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/index.ts' }),
    });
    assert.deepEqual(await deletedProjectFile.json(), { deleted: true });
    const invalidProjectFile = await fetch(`${baseUrl}/api/projects/project-1/file?path=..%2Foutside`);
    assert.equal(invalidProjectFile.status, 400);
    const projectCommand = await fetch(`${baseUrl}/api/projects/project-1/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'git status --short', timeout: 60 }),
    });
    assert.deepEqual(await projectCommand.json(), { output: '60s: git status --short' });
    const startedProjectTerminal = await fetch(`${baseUrl}/api/projects/project-1/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    assert.deepEqual(await startedProjectTerminal.json(), { terminalId: 'terminal-1', pid: 123 });
    const projectTerminalOutput = await fetch(`${baseUrl}/api/projects/project-1/terminal?terminalId=terminal-1`);
    assert.deepEqual(await projectTerminalOutput.json(), { output: '', running: true, exitCode: null, truncated: false });
    const projectTerminalInput = await fetch(`${baseUrl}/api/projects/project-1/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'input', terminalId: 'terminal-1', input: 'echo ok\n' }),
    });
    assert.deepEqual(await projectTerminalInput.json(), { sent: true });
    const stoppedProjectTerminal = await fetch(`${baseUrl}/api/projects/project-1/terminal?terminalId=terminal-1`, { method: 'DELETE' });
    assert.deepEqual(await stoppedProjectTerminal.json(), { stopped: true });
    const invalidProjectCommand = await fetch(`${baseUrl}/api/projects/project-1/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'git status', timeout: 301 }),
    });
    assert.equal(invalidProjectCommand.status, 400);
    const projectTasks = await fetch(`${baseUrl}/api/projects/project-1/tasks`);
    assert.deepEqual(await projectTasks.json(), []);
    const addedProjectTask = await fetch(`${baseUrl}/api/projects/project-1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Add plan', description: 'Make it live.' }),
    });
    assert.deepEqual(await addedProjectTask.json(), { id: 'task-1', title: 'Add plan', description: 'Make it live.', status: 'pending', createdAt: 1, updatedAt: 1 });
    const createdFolder = await fetch(`${baseUrl}/api/projects/project-1/directories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/components' }),
    });
    assert.deepEqual(await createdFolder.json(), { projectId: 'project-1', path: 'src/components' });
    const movedProjectEntry = await fetch(`${baseUrl}/api/projects/project-1/entries`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/index.ts', destination: 'src/main.ts' }),
    });
    assert.deepEqual(await movedProjectEntry.json(), { path: 'src/main.ts' });
    const projectStorage = await fetch(`${baseUrl}/api/projects/project-1/storage`);
    assert.deepEqual(await projectStorage.json(), { fileCount: 0, directoryCount: 0, bytes: 0 });
    const createdAgent = await fetch(`${baseUrl}/api/workspace-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-1', name: 'Analyst', emoji: '🧠', instructions: 'Analyze research.' }),
    });
    assert.equal(createdAgent.status, 201);
    assert.deepEqual(await createdAgent.json(), { id: 'agent-1', projectId: 'project-1', name: 'Analyst', emoji: '🧠', instructions: 'Analyze research.' });
    const saveIntegration = await fetch(`${baseUrl}/api/integrations/n8n`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'must-not-be-returned' }),
    });
    assert.equal(saveIntegration.status, 200);
    assert.deepEqual(await saveIntegration.json(), { configured: true });
    const testIntegration = await fetch(`${baseUrl}/api/integrations/n8n/test`, { method: 'POST' });
    assert.equal(testIntegration.status, 200);
    assert.equal(integrationTests, 1);
    const deleteIntegration = await fetch(`${baseUrl}/api/integrations/n8n`, { method: 'DELETE' });
    assert.deepEqual(await deleteIntegration.json(), { configured: false });
    assert.equal(configuredProvider, '');

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
    assert.doesNotMatch(chatEvents, /"type":"text_delta"/);
    assert.match(chatEvents, /"type":"done","result":\{"text":"Hello"\}/);
    assert.deepEqual(chatAdminContexts, [true]);

    const crossOriginChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
      body: JSON.stringify({ text: 'Hello', sessionId: 'web-session', trustedAdminContext: true }),
    });
    assert.equal(crossOriginChat.status, 200);
    await crossOriginChat.text();
    assert.deepEqual(chatAdminContexts, [true, false]);

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
    assert.equal(started.at(-1)?.trustedAdminContext, true);
    assert.deepEqual(started[0], {
      name: 'API review',
      prompt: 'Review the API.',
      sessionId: 'web-session',
      trustedAdminContext: true,
    });

    const archiveResponse = await fetch(`${baseUrl}/api/sessions/web-session`, { method: 'DELETE' });
    assert.equal(archiveResponse.status, 200);
    assert.deepEqual(await archiveResponse.json(), { archived: true });
    const archiveSubagentResponse = await fetch(`${baseUrl}/api/sessions/subagent%3Acompleted`, { method: 'DELETE' });
    assert.equal(archiveSubagentResponse.status, 200);
    assert.deepEqual(await archiveSubagentResponse.json(), { archived: true });

    const stopResponse = await fetch(`${baseUrl}/api/runs/run-2/stop`, { method: 'POST' });
    assert.equal(stopResponse.status, 200);
    assert.equal(stoppedRun, 'run-2');

    const archiveRunResponse = await fetch(`${baseUrl}/api/runs/run-2/archive`, { method: 'POST' });
    assert.equal(archiveRunResponse.status, 200);
    assert.deepEqual(await archiveRunResponse.json(), { archived: true });
    assert.equal(archivedRun, 'run-2');

    const restoreRunResponse = await fetch(`${baseUrl}/api/runs/run-2/restore`, { method: 'POST' });
    assert.equal(restoreRunResponse.status, 200);
    assert.deepEqual(await restoreRunResponse.json(), { restored: true });
    assert.equal(restoredRun, 'run-2');

    const runRestartResponse = await fetch(`${baseUrl}/api/runs/run-1/restart`, { method: 'POST' });
    assert.equal(runRestartResponse.status, 201);
    assert.deepEqual(await runRestartResponse.json(), { id: 'run-3', status: 'running' });

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
      body: JSON.stringify({ name: '  Pathfinder  ', emoji: 'terminal', soulContent: '# Soul\n- Name: old', agentsContent: '# Rules\n- Name: old', instructions: 'Be precise.' }),
    });
    assert.equal(identityResponse.status, 200);
    assert.deepEqual(identityUpdates, [{
      name: 'Pathfinder',
      emoji: 'terminal',
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
    fs.rmSync(updateDirectory, { recursive: true, force: true });
  }
});

test('main-agent workspace task tool can list and control Kanban runs', async () => {
  const actions: Array<{ action: string; id?: string; message?: string }> = [];
  const tool = createWorkspaceTaskTool({
    listRuns: () => [{ id: 'run-1', status: 'running' }],
    stopRun: id => { actions.push({ action: 'stop', id }); return true; },
    restartRun: id => { actions.push({ action: 'restart', id }); return { id: 'run-2', status: 'running' }; },
    guideRun: (id, message) => { actions.push({ action: 'guide', id, message }); return { id: 'run-3', status: 'running' }; },
    getProjectId: sessionId => sessionId === 'project-session' ? 'project-1' : undefined,
    listProjectTasks: () => [{ id: 'task-1', title: 'Plan', description: '', status: 'pending', createdAt: 1, updatedAt: 1 }],
    addProjectTask: (_projectId, title) => ({ id: 'task-2', title, description: '', status: 'pending', createdAt: 2, updatedAt: 2 }),
    updateProjectTask: (_projectId, id, patch) => ({ id, title: patch.title ?? 'Plan', description: '', status: patch.status ?? 'pending', createdAt: 1, updatedAt: 2 }),
    deleteProjectTask: (_projectId, id) => id === 'task-1',
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
  assert.equal(JSON.parse(await tool.execute({ action: 'todo_list' }, { sessionId: 'project-session' }))[0].id, 'task-1');
  assert.equal(JSON.parse(await tool.execute({ action: 'todo_add', title: 'Deploy' }, { sessionId: 'project-session' })).title, 'Deploy');
  assert.equal(JSON.parse(await tool.execute({ action: 'todo_update', taskId: 'task-1', status: 'completed' }, { sessionId: 'project-session' })).status, 'completed');
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'todo_delete', taskId: 'task-1' }, { sessionId: 'project-session' })), { deleted: true, taskId: 'task-1' });
  await assert.rejects(tool.execute({ action: 'todo_list' }, { sessionId: 'unscoped' }), /assigned to a project/);
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
