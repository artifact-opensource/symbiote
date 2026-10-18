import type { WorkspaceAgentProfile, WorkspaceProject } from '../../agent/workspace-registry.js';
import type { ToolDefinition } from '../types.js';

export interface WorkspaceManagementControls {
  listProjects: () => WorkspaceProject[];
  listAgents: (projectId?: string) => WorkspaceAgentProfile[];
  createProject: (name: string, scope?: string) => WorkspaceProject;
  createAgent: (input: { projectId: string; name: string; emoji: string; instructions: string }) => WorkspaceAgentProfile;
}

export function createWorkspaceManagementTool(controls: WorkspaceManagementControls): ToolDefinition {
  return {
    name: 'workspace_manage',
    description: 'Create and inspect workspace projects and agent profiles. Admin-only. Creating an agent profile does not start a run; use spawn for a task that should run now.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['project_list', 'project_create', 'agent_list', 'agent_create'],
          description: 'Workspace management action.',
        },
        projectId: { type: 'string', description: 'Project ID for agent_list and agent_create.' },
        name: { type: 'string', description: 'Project or agent name.' },
        scope: { type: 'string', description: 'Optional project work scope.' },
        emoji: { type: 'string', description: 'Agent avatar icon identifier (for example: bot, brain, terminal, or compass).' },
        instructions: { type: 'string', description: 'Instructions for the new agent profile.' },
      },
      required: ['action'],
    },
    idempotency: {
      class: 'irreversible',
      irreversibleReason: 'Workspace management creates projects and agent profiles that persist in the workspace registry. Once created, they cannot be removed through this tool.',
      idempotencyKey: (input) => `workspace_manage:${String(input.action ?? '')}:${String(input.projectId ?? '')}:${String(input.name ?? '')}`,
    },
    execute: async (input, options) => {
      if (options?.sessionTier !== 'admin') {
        throw new Error('Project and agent creation is only available in admin sessions.');
      }

      switch (input.action) {
        case 'project_list':
          return JSON.stringify(controls.listProjects());
        case 'project_create': {
          const name = typeof input.name === 'string' ? input.name : '';
          const scope = typeof input.scope === 'string' ? input.scope : '';
          return JSON.stringify(controls.createProject(name, scope));
        }
        case 'agent_list': {
          const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
          return JSON.stringify(controls.listAgents(projectId || undefined));
        }
        case 'agent_create': {
          const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
          const name = typeof input.name === 'string' ? input.name : '';
          const emoji = typeof input.emoji === 'string' ? input.emoji : '';
          const instructions = typeof input.instructions === 'string' ? input.instructions : '';
          if (!projectId) throw new Error('agent_create requires an active projectId.');
          return JSON.stringify(controls.createAgent({ projectId, name, emoji, instructions }));
        }
        default:
          throw new Error('Choose project_list, project_create, agent_list, or agent_create.');
      }
    },
  };
}
