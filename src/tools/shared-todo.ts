import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SharedTodoItem {
  id: string;
  text: string;
  status: 'active' | 'done' | 'blocked';
  createdAt: string;
  updatedAt: string;
  scope: string;
}

export interface SharedTodoDocument {
  active: SharedTodoItem[];
  completed: SharedTodoItem[];
}

export function resolveSharedTodoPath(scope = 'user'): string {
  const candidates = [
    join(process.cwd(), '.sessions', 'shared', `${scope}.json`),
    join(process.cwd(), '.sessions', 'workspace', 'shared', `${scope}.json`),
    join(process.cwd(), 'workspace', 'shared', `${scope}.json`),
    join(process.cwd(), '.shared-todos', `${scope}.json`),
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // keep checking next candidate
    }
  }

  return candidates[0];
}

function readSharedTodoDocument(scope: string): SharedTodoDocument {
  const todoPath = resolveSharedTodoPath(scope);
  mkdirSync(dirname(todoPath), { recursive: true });

  try {
    const raw = readFileSync(todoPath, 'utf8').trim();
    if (!raw) return { active: [], completed: [] };
    const parsed = JSON.parse(raw) as Partial<SharedTodoDocument>;
    return {
      active: Array.isArray(parsed.active) ? parsed.active as SharedTodoItem[] : [],
      completed: Array.isArray(parsed.completed) ? parsed.completed as SharedTodoItem[] : [],
    };
  } catch {
    return { active: [], completed: [] };
  }
}

function writeSharedTodoDocument(scope: string, doc: SharedTodoDocument): void {
  const todoPath = resolveSharedTodoPath(scope);
  mkdirSync(dirname(todoPath), { recursive: true });
  writeFileSync(todoPath, JSON.stringify(doc, null, 2));
}

export function listSharedTodoItems(scope: string): SharedTodoItem[] {
  const doc = readSharedTodoDocument(scope);
  return [...doc.active, ...doc.completed];
}

export function addSharedTodo(scope: string, text: string): string {
  const safeText = text.trim();
  if (!safeText) return 'No todo text provided';

  const doc = readSharedTodoDocument(scope);
  const item: SharedTodoItem = {
    id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: safeText,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scope,
  };

  doc.active.unshift(item);
  writeSharedTodoDocument(scope, doc);
  return `Shared todo created: ${item.id} — ${safeText}`;
}

export function markSharedTodoDone(scope: string, id: string): string {
  const doc = readSharedTodoDocument(scope);
  const activeMatch = doc.active.find(item => item.id === id);
  if (activeMatch) {
    activeMatch.status = 'done';
    activeMatch.updatedAt = new Date().toISOString();
    doc.completed.unshift({ ...activeMatch, status: 'done' });
    doc.active = doc.active.filter(item => item.id !== id);
    writeSharedTodoDocument(scope, doc);
    return `Shared todo marked done: ${id}`;
  }

  return `Shared todo not found: ${id}`;
}

export function clearSharedTodoScope(scope: string): string {
  const doc: SharedTodoDocument = { active: [], completed: [] };
  writeSharedTodoDocument(scope, doc);
  return `Cleared shared todos for scope: ${scope}`;
}
