import { TodoManager, type TodoItem, type TodoStatus } from '../agent/todo.js';
import type { ToolDefinition } from './types.js';

export type SharedTodoStatus = TodoStatus;
export type SharedTodoItem = TodoItem;

export function resolveSharedTodoPath(scope = 'user'): string {
  return new TodoManager({ scope, workspace: process.cwd() }).storagePath;
}

export function listSharedTodoItems(scope: string): SharedTodoItem[] {
  return new TodoManager({ scope, workspace: process.cwd() }).list();
}

export function addSharedTodo(scope: string, text: string, description?: string): string {
  const manager = new TodoManager({ scope, workspace: process.cwd() });
  const item = manager.addTask(text, description);
  return `Shared todo created: ${item.id} — ${item.title}`;
}

export function markSharedTodoDone(scope: string, id: string): string {
  const manager = new TodoManager({ scope, workspace: process.cwd() });
  const updated = manager.updateTask(id, { status: 'completed' });
  if (!updated) {
    return `Shared todo not found: ${id}`;
  }
  return `Shared todo marked done: ${id}`;
}

export function clearSharedTodoScope(scope: string): string {
  const manager = new TodoManager({ scope, workspace: process.cwd() });
  manager.clear();
  return `Cleared shared todos for scope: ${scope}`;
}

export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage the agent task list using a persistent checklist.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'One of list, add, update, complete, clear, render',
        enum: ['list', 'add', 'update', 'complete', 'clear', 'render'],
      },
      scope: {
        type: 'string',
        description: 'Task bucket / session scope for the list.',
      },
      title: {
        type: 'string',
        description: 'Title to add to the task list.',
      },
      description: {
        type: 'string',
        description: 'Optional detail for the task.',
      },
      id: {
        type: 'string',
        description: 'Task ID for update or completion',
      },
      status: {
        type: 'string',
        description: 'New task state',
        enum: ['pending', 'in_progress', 'completed', 'blocked'],
      },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = String(input.action ?? 'list');
    const scope = String(input.scope ?? 'default');
    const manager = new TodoManager({ scope, workspace: process.cwd() });

    switch (action) {
      case 'add': {
        const title = String(input.title ?? '').trim();
        if (!title) return JSON.stringify({ error: 'Todo title is required.' });
        const item = manager.addTask(title, typeof input.description === 'string' ? input.description : undefined);
        return JSON.stringify({ ok: true, item });
      }
      case 'update': {
        const id = String(input.id ?? '');
        if (!id) return JSON.stringify({ error: 'Todo id is required.' });
        const updated = manager.updateTask(id, {
          title: typeof input.title === 'string' ? input.title : undefined,
          description: typeof input.description === 'string' ? input.description : undefined,
          status: typeof input.status === 'string' ? input.status as TodoStatus : undefined,
        });
        return JSON.stringify({ ok: !!updated, item: updated ?? null });
      }
      case 'complete': {
        const id = String(input.id ?? '');
        if (!id) return JSON.stringify({ error: 'Todo id is required.' });
        const updated = manager.updateTask(id, { status: 'completed' });
        return JSON.stringify({ ok: !!updated, item: updated ?? null });
      }
      case 'clear': {
        manager.clear();
        return JSON.stringify({ ok: true, items: [] });
      }
      case 'render': {
        return JSON.stringify({ ok: true, markdown: manager.renderMarkdown(), summary: manager.progressSummary() });
      }
      case 'list':
      default: {
        const items = manager.list();
        return JSON.stringify({ ok: true, items, summary: manager.progressSummary(), markdown: manager.renderMarkdown() });
      }
    }
  },
};
