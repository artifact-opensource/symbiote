import type { ToolDefinition } from '../types.js';

export interface WorkspaceTaskControls {
  listRuns: () => unknown[];
  stopRun: (id: string) => boolean;
  restartRun: (id: string) => unknown | null;
  guideRun: (id: string, message: string) => unknown | null;
}

export function createWorkspaceTaskTool(controls: WorkspaceTaskControls): ToolDefinition {
  return {
    name: 'workspace_tasks',
    description: 'List and control tasks shown on the Workspace Kanban. Use guide to nudge a task, restart to replay a stopped or finished task, and stop to cancel an active task.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'guide', 'restart', 'stop'], description: 'Kanban action to perform.' },
        runId: { type: 'string', description: 'Task run ID for guide, restart, or stop.' },
        message: { type: 'string', description: 'Guidance to send to the task for the guide action.' },
      },
      required: ['action'],
    },
    execute: async input => {
      const action = input.action;
      if (action === 'list') return JSON.stringify(controls.listRuns(), null, 2);
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
