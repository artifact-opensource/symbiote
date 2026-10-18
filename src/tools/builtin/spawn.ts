// Symbiote — Spawn sub-agent tool
// Allows the agent to spawn sub-agents for parallel/background tasks.

import type { ToolDefinition } from '../types.js';
import type { SubAgentManager } from '../../sessions/sub-agent.js';
import type { Provider, ProviderConfig } from '../../providers/types.js';
import type { ToolExecutor } from '../../agent/runner.js';

export function createSpawnTool(
  subAgentManager: SubAgentManager,
  provider: Provider,
  providerConfig: ProviderConfig,
  toolRegistry: ToolExecutor,
  workspace: string | ((sessionId: string) => { path: string; projectId?: string; agentId?: string }),
): ToolDefinition {
  return {
    name: 'spawn',
    description: 'Spawn a sub-agent to handle a task in the background. Returns immediately with a handle ID. Use process_poll-style checking to monitor completion. Max depth: 3.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task for the sub-agent to complete' },
        maxIterations: { type: 'number', description: 'Optional iteration cap per runner pass. BLINK can continue across passes; without a cap, the sub-agent starts at 100 iterations and PULSE may expand to 1,000.' },
      },
      required: ['task'],
    },
    idempotency: {
      class: 'external',
      externalSystem: 'sub_agent_manager',
      irreversibleReason: 'Spawning a sub-agent creates a new agent session with its own resource allocation and execution context that cannot be automatically reversed.',
      idempotencyKey: (input) => {
        const task = String(input.task ?? '');
        const maxIterations = input.maxIterations ?? 0;
        return `spawn:${task.slice(0, 64)}:${maxIterations}`;
      },
    },
    async execute(input, opts) {
      const task = String(input.task ?? '');
      const maxIterations = input.maxIterations === undefined ? undefined : Number(input.maxIterations);
      if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
        return JSON.stringify({ error: 'maxIterations must be a positive integer.' });
      }
      const parentSessionId = opts?.sessionId ?? 'unknown';
      const parentDepth = subAgentManager.getDepth(parentSessionId);
      const scopedWorkspace = typeof workspace === 'string' ? { path: workspace } : workspace(parentSessionId);

      try {
        const handle = await subAgentManager.spawn(
          {
            task,
            parentSessionId,
            projectId: scopedWorkspace.projectId,
            agentId: scopedWorkspace.agentId,
            depth: parentDepth + 1,
            ...(maxIterations === undefined ? {} : { maxIterations }),
            ...(opts?.sessionTier ? { parentTier: opts.sessionTier } : {}),
            ...(opts?.googleWorkspaceAccessToken ? { googleWorkspaceAccessToken: opts.googleWorkspaceAccessToken } : {}),
          },
          provider,
          providerConfig,
          toolRegistry,
          scopedWorkspace.path,
        );

        return JSON.stringify({
          spawned: true,
          sessionId: handle.sessionId,
          task: handle.task,
          status: handle.status,
          ...(handle.error ? { error: handle.error } : {}),
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

/** Tool to check sub-agent status */
export function createSubAgentStatusTool(subAgentManager: SubAgentManager): ToolDefinition {
  return {
    name: 'subagent_status',
    description: 'Check the status of a spawned sub-agent. Returns status, result (if complete), or error.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Sub-agent session ID (from spawn result)' },
        action: { type: 'string', description: 'Action: "status" (default), "list", "kill", "steer"', enum: ['status', 'list', 'kill', 'steer'] },
        message: { type: 'string', description: 'Steering message (when action="steer")' },
      },
      required: [],
    },
    idempotency: {
      class: 'read',
      idempotencyKey: (input) => {
        const action = String(input.action ?? 'list');
        const sessionId = String(input.sessionId ?? '');
        return `subagent_status:${action}:${sessionId}`;
      },
    },
    async execute(input) {
      const action = String(input.action ?? 'list');
      const sessionId = String(input.sessionId ?? '');

      switch (action) {
        case 'list':
          return JSON.stringify(subAgentManager.list().map(a => ({
            sessionId: a.sessionId,
            task: a.task.slice(0, 100),
            status: a.status,
            startedAt: a.startedAt,
            completedAt: a.completedAt,
          })));

        case 'status': {
          const handle = subAgentManager.get(sessionId);
          if (!handle) return JSON.stringify({ error: `No sub-agent found: ${sessionId}` });
          return JSON.stringify({
            sessionId: handle.sessionId,
            task: handle.task,
            status: handle.status,
            result: handle.result?.slice(0, 2000),
            error: handle.error,
            startedAt: handle.startedAt,
            completedAt: handle.completedAt,
          });
        }

        case 'kill':
          return JSON.stringify({ killed: subAgentManager.kill(sessionId) });

        case 'steer':
          return JSON.stringify({ steered: subAgentManager.steer(sessionId, String(input.message ?? '')) });

        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }
    },
  };
}