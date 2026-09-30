import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  description?: string;
  createdAt: string;
  updatedAt: string;
  order: number;
}

export interface TodoState {
  version: 1;
  scope: string;
  items: TodoItem[];
  updatedAt: string;
}

export interface TodoManagerOptions {
  scope?: string;
  workspace?: string;
  filePath?: string;
}

export class TodoManager {
  public readonly scope: string;
  public readonly workspace: string;
  public readonly storagePath: string;

  constructor(options: TodoManagerOptions = {}) {
    this.scope = (options.scope ?? 'default').trim() || 'default';
    this.workspace = options.workspace ?? process.cwd();
    this.storagePath = options.filePath ?? join(this.workspace, '.symbiote', 'todos', `${this.scope}.json`);
  }

  static defaultState(scope: string): TodoState {
    return {
      version: 1,
      scope,
      items: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private ensureStorage(): void {
    mkdirSync(dirname(this.storagePath), { recursive: true });
  }

  private readState(): TodoState {
    this.ensureStorage();
    if (!existsSync(this.storagePath)) {
      return TodoManager.defaultState(this.scope);
    }

    try {
      const raw = readFileSync(this.storagePath, 'utf8').trim();
      if (!raw) {
        return TodoManager.defaultState(this.scope);
      }

      const parsed = JSON.parse(raw) as Partial<TodoState>;
      const items = Array.isArray(parsed.items) ? parsed.items as TodoItem[] : [];
      return {
        version: 1,
        scope: parsed.scope ?? this.scope,
        items: items.map((item, index) => ({
          id: item.id ?? randomUUID(),
          title: item.title ?? `Task ${index + 1}`,
          status: item.status ?? 'pending',
          description: item.description,
          createdAt: item.createdAt ?? new Date().toISOString(),
          updatedAt: item.updatedAt ?? new Date().toISOString(),
          order: item.order ?? index,
        })),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return TodoManager.defaultState(this.scope);
    }
  }

  private writeState(state: TodoState): void {
    this.ensureStorage();
    writeFileSync(this.storagePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  }

  private sortItems(items: TodoItem[]): TodoItem[] {
    return [...items].sort((a, b) => {
      const statusWeight = { pending: 0, in_progress: 1, blocked: 2, completed: 3 };
      const byStatus = statusWeight[a.status] - statusWeight[b.status];
      if (byStatus !== 0) return byStatus;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }

  list(): TodoItem[] {
    return this.sortItems(this.readState().items);
  }

  addTask(title: string, description?: string): TodoItem {
    const safeTitle = title.trim();
    if (!safeTitle) {
      throw new Error('Todo title is required.');
    }

    const state = this.readState();
    const item: TodoItem = {
      id: randomUUID(),
      title: safeTitle,
      status: 'pending',
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      order: state.items.length,
    };

    state.items.push(item);
    this.writeState(state);
    return item;
  }

  updateTask(id: string, patch: Partial<Pick<TodoItem, 'title' | 'status' | 'description' | 'order'>>): TodoItem | undefined {
    const state = this.readState();
    const index = state.items.findIndex(item => item.id === id);
    if (index === -1) return undefined;

    const existing = state.items[index];
    const updated: TodoItem = {
      ...existing,
      title: patch.title?.trim() ? patch.title.trim() : existing.title,
      status: patch.status ?? existing.status,
      description: patch.description ?? existing.description,
      order: patch.order ?? existing.order,
      updatedAt: new Date().toISOString(),
    };

    state.items[index] = updated;
    this.writeState(state);
    return updated;
  }

  removeTask(id: string): boolean {
    const state = this.readState();
    const before = state.items.length;
    state.items = state.items.filter(item => item.id !== id);
    if (state.items.length === before) return false;
    this.writeState(state);
    return true;
  }

  clear(): void {
    const nextState = TodoManager.defaultState(this.scope);
    this.writeState(nextState);
  }

  progressSummary(): { total: number; pending: number; in_progress: number; completed: number; blocked: number } {
    const items = this.list();
    return {
      total: items.length,
      pending: items.filter(item => item.status === 'pending').length,
      in_progress: items.filter(item => item.status === 'in_progress').length,
      completed: items.filter(item => item.status === 'completed').length,
      blocked: items.filter(item => item.status === 'blocked').length,
    };
  }

  renderMarkdown(): string {
    const items = this.list();
    if (items.length === 0) {
      return 'No tasks yet.';
    }

    const statusGlyph: Record<TodoStatus, string> = {
      pending: '□',
      in_progress: '→',
      completed: '✓',
      blocked: '!'
    };

    return items.map((item, index) => {
      const desc = item.description ? ` — ${item.description}` : '';
      return `${index + 1}. ${statusGlyph[item.status]} ${item.title}${desc}`;
    }).join('\n');
  }
}
