import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceManagementTool } from '../tools/builtin/workspace-management.js';
import { configureSandbox, createSandboxedRegistry } from '../tools/sandbox.js';

test('workspace management is owner-only and creates projects and agent profiles', async () => {
  configureSandbox(undefined);
  const created: string[] = [];
  const tool = createWorkspaceManagementTool({
    listProjects: () => [],
    listAgents: () => [],
    createProject: (name) => {
      created.push(`project:${name}`);
      return { id: 'project-1', name, workspace: 'projects/project-1/workspace', createdAt: 1 };
    },
    createAgent: (input) => {
      created.push(`agent:${input.name}`);
      return { id: 'agent-1', ...input, workspace: 'projects/project-1/agents/agent-1', createdAt: 1 };
    },
  });
  const inner = {
    list: () => [tool],
    toProviderFormat: () => [],
    execute: (name: string, input: Record<string, unknown>, options?: Parameters<typeof tool.execute>[1]) => {
      if (name !== tool.name) throw new Error(`Unexpected tool: ${name}`);
      return tool.execute(input, options);
    },
  };
  const baseContext = {
    sessionId: 'workspace-admin-test',
    adapterId: 'http-api',
    channelType: 'http',
    chatType: 'direct' as const,
    senderId: 'operator',
    isOwner: false,
  };
  const restricted = createSandboxedRegistry(inner, baseContext);
  assert.equal(restricted.list().some(entry => entry.name === 'workspace_manage'), false);
  assert.equal(JSON.parse(await restricted.execute('workspace_manage', { action: 'project_create', name: 'Blocked' })).sandbox, true);

  const admin = createSandboxedRegistry(inner, { ...baseContext, isOwner: true });
  assert.equal(admin.list().some(entry => entry.name === 'workspace_manage'), true);
  assert.deepEqual(JSON.parse(await admin.execute('workspace_manage', { action: 'project_create', name: 'Research' })), {
    id: 'project-1',
    name: 'Research',
    workspace: 'projects/project-1/workspace',
    createdAt: 1,
  });
  assert.deepEqual(JSON.parse(await admin.execute('workspace_manage', {
    action: 'agent_create',
    projectId: 'project-1',
    name: 'Analyst',
    emoji: '🧠',
    instructions: 'Analyze research.',
  })), {
    id: 'agent-1',
    projectId: 'project-1',
    name: 'Analyst',
    emoji: '🧠',
    instructions: 'Analyze research.',
    workspace: 'projects/project-1/agents/agent-1',
    createdAt: 1,
  });
  assert.deepEqual(created, ['project:Research', 'agent:Analyst']);
});
