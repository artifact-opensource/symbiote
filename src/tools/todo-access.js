// Minimal todo access for agent — echo on Discord like tool execution
const fs = require('fs');
const path = '/home/adam/worxpace/av_workspace/workspace/todos/todos.json';
function listTodos() {
  try {
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    return JSON.stringify({ active: data.active || [], completed: data.completed || [] });
  } catch { return '{"active":[],"completed":[]}'; }
}
function addTodo(task) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  const id = 't' + Date.now();
  data.active.push({ id, task, status: 'in_progress', created: new Date().toISOString() });
  fs.writeFileSync(path, JSON.stringify(data));
  return `Todo created: ${id} — ${task}`;
}
module.exports = { listTodos, addTodo };
