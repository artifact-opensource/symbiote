// Symbiote — Builtin tool: cron management

import type { CronManager, CronSchedule, UpdateCronJobInput } from '../../cron/manager.js';
import type { ToolDefinition } from '../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSchedule(value: unknown): CronSchedule {
  if (!isRecord(value)) throw new Error('A schedule object is required.');
  if (value.type === 'cron' && typeof value.expression === 'string') {
    return { type: 'cron', expression: value.expression };
  }
  if (value.type === 'once' && typeof value.runAt === 'number') {
    return { type: 'once', runAt: value.runAt };
  }
  throw new Error('Schedule must be { type: "cron", expression: "…" } or { type: "once", runAt: <Unix milliseconds> }.');
}

export function createCronManageTool(manager: CronManager): ToolDefinition {
  return {
    name: 'cron_manage',
    description: 'Create, list, update, pause, resume, or delete recurring cron jobs and one-time reminders. Jobs create autonomous agent runs at their scheduled time. Retry only failed alerts after inspecting whether the task already caused side effects; interrupted or failed executions are never automatically replayed. Use the user’s local timezone; cron expressions have five fields (minute hour day-of-month month day-of-week).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'retry_alert', 'set_default_prompt'], description: 'Operation to perform.' },
        id: { type: 'string', description: 'Job ID for update/delete, or alert ID for retry_alert.' },
        name: { type: 'string', description: 'Short job name.' },
        prompt: { type: 'string', description: 'Task instructions to execute when the schedule fires.' },
        schedule: {
          type: 'object',
          description: 'Recurring: {type:"cron", expression:"30 9 * * 1-5"}. One-time: {type:"once", runAt:<Unix milliseconds>}.',
          properties: {
            type: { type: 'string', enum: ['cron', 'once'] },
            expression: { type: 'string', description: 'Five-field cron expression, interpreted in the machine local timezone.' },
            runAt: { type: 'number', description: 'One-time reminder time as Unix epoch milliseconds.' },
          },
        },
        enabled: { type: 'boolean', description: 'Whether the job should run. Set false to pause it.' },
        defaultPrompt: { type: 'string', description: 'Replacement dedicated system instructions for the autonomous default agent.' },
      },
      required: ['action'],
    },
    idempotency: {
      class: 'reversible_local',
      reverseDescription: 'To reverse cron changes, use update/delete actions. Cron jobs are stored in the scheduler state file.',
      idempotencyKey: (input) => {
        const action = String(input.action ?? '');
        const id = String(input.id ?? '');
        const name = String(input.name ?? '');
        const prompt = String(input.prompt ?? '');
        return `cron_manage:${action}:${id}:${name}:${prompt.slice(0, 64)}`;
      },
    },
    execute: async input => {
      switch (input.action) {
        case 'list':
          return JSON.stringify({ jobs: manager.listJobs(), alerts: manager.listAlerts() }, null, 2);
        case 'create': {
          if (typeof input.name !== 'string' || typeof input.prompt !== 'string') {
            throw new Error('Creating a cron job requires name and prompt strings.');
          }
          const job = manager.createJob({
            name: input.name,
            prompt: input.prompt,
            schedule: parseSchedule(input.schedule),
            ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
          });
          return JSON.stringify(job, null, 2);
        }
        case 'update': {
          if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Updating a cron job requires its id.');
          const patch: UpdateCronJobInput = {};
          if (input.name !== undefined) {
            if (typeof input.name !== 'string') throw new Error('Job name must be a string.');
            patch.name = input.name;
          }
          if (input.prompt !== undefined) {
            if (typeof input.prompt !== 'string') throw new Error('Job prompt must be a string.');
            patch.prompt = input.prompt;
          }
          if (input.schedule !== undefined) patch.schedule = parseSchedule(input.schedule);
          if (input.enabled !== undefined) {
            if (typeof input.enabled !== 'boolean') throw new Error('Job enabled must be a boolean.');
            patch.enabled = input.enabled;
          }
          return JSON.stringify(manager.updateJob(input.id.trim(), patch), null, 2);
        }
        case 'delete': {
          if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Deleting a cron job requires its id.');
          if (!manager.deleteJob(input.id.trim())) throw new Error(`Cron job ${input.id} was not found.`);
          return JSON.stringify({ deleted: true, id: input.id.trim() });
        }
        case 'retry_alert': {
          if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Retrying an alert requires its id.');
          return JSON.stringify(manager.retryAlert(input.id.trim()), null, 2);
        }
        case 'set_default_prompt': {
          if (typeof input.defaultPrompt !== 'string') throw new Error('Setting the default agent prompt requires defaultPrompt text.');
          return JSON.stringify({ systemPrompt: manager.updateDefaultAgentPrompt(input.defaultPrompt) });
        }
        default:
          throw new Error('Choose a valid cron action: list, create, update, delete, retry_alert, or set_default_prompt.');
      }
    },
  };
}