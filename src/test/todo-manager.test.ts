import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TodoManager } from '../agent/todo.js';

test('todo manager creates and progresses checklist items', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-todo-test-'));
  const manager = new TodoManager({ scope: 'unit-test', workspace });

  try {
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
