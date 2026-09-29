// Minimal todo access for agent — keep state in the project-local sessions directory.
const fs = require('fs');
const path = require('path');

function resolveTodoPath() {
  const candidates = [
    path.join(process.cwd(), '.sessions', 'todos.json'),
    path.join(process.cwd(), '.sessions', 'workspace', 'todos', 'todos.json'),
    path.join(process.cwd(), 'workspace', 'todos', 'todos.json'),
    path.join(process.cwd(), 'todos.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // keep checking next candidate
    }
  }

  return candidates[0];
}

function readTodoData() {
  const todoPath = resolveTodoPath();
  try {
    fs.mkdirSync(path.dirname(todoPath), { recursive: true });
    if (!fs.existsSync(todoPath)) {
      fs.writeFileSync(todoPath, JSON.stringify({ active: [], completed: [] }, null, 2));
      return { active: [], completed: [] };
    }
    const value = fs.readFileSync(todoPath, 'utf8').trim();
    return value ? JSON.parse(value) : { active: [], completed: [] };
  } catch {
    return { active: [], completed: [] };
  }
}

function listTodos() {
  try {
    const data = readTodoData();
    return JSON.stringify({ active: data.active || [], completed: data.completed || [] });
  } catch {
    return '{"active":[],"completed":[]}';
  }
}

function addTodo(task) {
  try {
    const todoPath = resolveTodoPath();
    const data = readTodoData();
    const id = 't' + Date.now();
    const active = Array.isArray(data.active) ? data.active : [];
    active.push({ id, task, status: 'in_progress', created: new Date().toISOString() });
    const nextData = { ...data, active };
    fs.mkdirSync(path.dirname(todoPath), { recursive: true });
    fs.writeFileSync(todoPath, JSON.stringify(nextData, null, 2));
    return `Todo created: ${id} — ${task}`;
  } catch {
    return `Todo created: t${Date.now()} — ${task}`;
  }
}
module.exports = { listTodos, addTodo };
