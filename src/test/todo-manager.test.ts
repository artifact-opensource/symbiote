import test from 'node:test';
import assert from 'node:assert/strict';

import { TodoManager } from '../agent/todo.js';

test('todo manager creates and progresses checklist items', () => {
  const manager = new TodoManager({ scope: 'unit-test', workspace: '/tmp/mach6-tests' });

  const taskA = manager.addTask('Inspect regression root cause');
  const taskB = manager.addTask('Implement targeted fix');

  assert.equal(manager.list().length, 2);
  assert.equal(taskA.status, 'pending');

  manager.updateTask(taskA.id, { status: 'in_progress' });
  manager.updateTask(taskB.id, { status: 'completed' });

  const active = manager.list().filter(item => item.status === 'in_progress');
  const completed = manager.list().filter(item => item.status === 'completed');

  assert.equal(active.length, 1);
  assert.equal(completed.length, 1);
  assert.match(manager.renderMarkdown(), /Inspect regression root cause/);
  assert.match(manager.renderMarkdown(), /Implement targeted fix/);
});
