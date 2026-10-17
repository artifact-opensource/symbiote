import type { ToolDefinition } from '../types.js';
import type { ProjectTask, ProjectTaskStatus } from '../../agent/workspace-registry.js';

export interface WorkspaceTaskControls {
  listRuns: () => unknown[];
  stopRun: (id: string) => boolean;
  restartRun: (id: string) => unknown | null;
  guideRun: (id: string, message: string) => unknown | null;
  getProjectId: (sessionId?: string) => string | undefined;
  listProjectTasks: (projectId: string) => ProjectTask[];
  addProjectTask: (projectId: string, title: string, description?: string) => ProjectTask;
  updateProjectTask: (projectId: string, id: string, patch: Partial<Pick<ProjectTask, 'title' | 'description' | 'status'>>) => ProjectTask;
  deleteProjectTask: (projectId: string, id: string) => boolean;
}

export function createWorkspaceTaskTool(controls: WorkspaceTaskControls): ToolDefinition {
  return {
    name: 'workspace_tasks',
    description: 'Manage project plans and execution tasks. Project todo actions are scoped to the project assigned to the current session; list, add, update status/details, or delete plan items. Use list_runs, guide, restart, or stop to control agent runs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'guide', 'restart', 'stop', 'todo_list', 'todo_add', 'todo_update', 'todo_delete'], description: 'Execution run or project-plan action.' },
        runId: { type: 'string', description: 'Task run ID for guide, restart, or stop.' },
        message: { type: 'string', description: 'Guidance to send to the task for the guide action.' },
        taskId: { type: 'string', description: 'Project todo ID for update or delete.' },
        title: { type: 'string', description: 'Project todo title.' },
        description: { type: 'string', description: 'Project todo details.' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'], description: 'New project todo status.' },
      },
      required: ['action'],
    },
    execute: async (input, options) => {
      const action = input.action;
      if (action === 'list') return JSON.stringify(controls.listRuns(), null, 2);
      if (typeof action === 'string' && action.startsWith('todo_')) {
        const projectId = controls.getProjectId(options?.sessionId);
        if (!projectId) throw new Error('Project plan actions require a session assigned to a project.');
        if (action === 'todo_list') return JSON.stringify(controls.listProjectTasks(projectId), null, 2);
        if (action === 'todo_add') {
          const title = typeof input.title === 'string' ? input.title : '';
          const description = typeof input.description === 'string' ? input.description : '';
          return JSON.stringify(controls.addProjectTask(projectId, title, description));
        }
        const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
        if (!taskId) throw new Error(`The ${action} action requires taskId.`);
        if (action === 'todo_delete') {
          if (!controls.deleteProjectTask(projectId, taskId)) throw new Error(`Project task ${taskId} was not found.`);
          return JSON.stringify({ deleted: true, taskId });
        }
        if (action === 'todo_update') {
          const status = input.status;
          if (status !== undefined && !['pending', 'in_progress', 'completed', 'blocked'].includes(String(status))) {
            throw new Error('Choose a valid project task status.');
          }
          const patch = {
            ...(typeof input.title === 'string' ? { title: input.title } : {}),
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            ...(typeof status === 'string' ? { status: status as ProjectTaskStatus } : {}),
          };
          if (Object.keys(patch).length === 0) throw new Error('Provide a task title, description, or status to update.');
          return JSON.stringify(controls.updateProjectTask(projectId, taskId, patch));
        }
        throw new Error('Choose todo_list, todo_add, todo_update, or todo_delete.');
      }
      if (action !== 'guide' && action !== 'restart' && action !== 'stop') {
        throw new Error('Choose a valid workspace task action: list, guide, restart, or stop.');
      }

      const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
      if (!runId) throw new Error(`The ${String(action)} action requires a task runId.`);

      if (action === 'stop') {
        if (!controls.stopRun(runId)) throw new Error(`Task ${runId} is not active or could not be stopped.`);
        return JSON.stringify({ stopped: true, runId });
      }
      if (action === 'restart') {
        const run = controls.restartRun(runId);
        if (!run) throw new Error(`Task ${runId} is missing, active, or its session is unavailable.`);
        return JSON.stringify(run);
      }
      if (action === 'guide') {
        const message = typeof input.message === 'string' ? input.message.trim() : '';
        if (!message) throw new Error('The guide action requires a non-empty message.');
        if (message.length > 2_000) throw new Error('Task guidance must be 2,000 characters or fewer.');
        const run = controls.guideRun(runId, message);
        if (!run) throw new Error(`Task ${runId} could not be guided because its session is unavailable.`);
        return JSON.stringify(run);
      }
      throw new Error('Workspace task action was not handled.');
    },
  };
}
