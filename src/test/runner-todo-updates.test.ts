import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent, formatTodoProgressUpdate } from '../agent/runner.js';
import { TodoManager } from '../agent/todo.js';
import type { Provider, StreamEvent } from '../providers/types.js';
import { todoTool } from '../tools/shared-todo.js';

test('completed checklist items notify the user before the runner continues to the next task', async () => {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-todo-updates-'));
  const scope = 'todo-update-flow';

  try {
    process.chdir(workspace);
    const todos = new TodoManager({ scope, workspace });
    const first = todos.addTask('Inspect the code');
    const second = todos.addTask('Verify the fix');
    const events: string[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: 'todo-update-test',
      async *stream(): AsyncGenerator<StreamEvent> {
        providerCalls++;
        events.push(`provider:${providerCalls}`);
        if (providerCalls === 1 || providerCalls === 3) {
          if (providerCalls === 3) assert.ok(events.includes(`update:${first.id}`));
          const task = providerCalls === 1 ? first : second;
          const id = `todo-call-${providerCalls}`;
          yield { type: 'tool_use_start', id, name: 'todo' };
          yield { type: 'tool_use_delta', id, input: JSON.stringify({ action: 'complete', id: task.id, scope }) };
          yield { type: 'tool_use_end', id };
          return;
        }
        yield { type: 'text_delta', text: providerCalls === 4 ? 'Both tasks are complete and verified.' : 'Draft result.' };
      },
    };

    const result = await runAgent([{ role: 'user', content: 'Inspect, fix, and verify this task.' }], {
      provider,
      providerConfig: { model: 'mock' },
      toolRegistry: {
        toProviderFormat: () => [],
        list: () => [todoTool],
        execute: (name, input) => name === 'todo'
          ? todoTool.execute(input)
          : Promise.resolve(`Unknown test tool: ${name}`),
      },
      todoScope: scope,
      maxIterations: 10,
      onTodoCompleted: update => { events.push(`update:${update.item.id}`); },
    });

    assert.equal(result.text, 'Both tasks are complete and verified.');
    assert.deepEqual(events.filter(event => event.startsWith('update:')), [
      `update:${first.id}`,
      `update:${second.id}`,
    ]);
    assert.ok(events.indexOf(`update:${first.id}`) < events.indexOf('provider:3'));
    assert.deepEqual(todos.list().map(item => item.status), ['completed', 'completed']);
    assert.equal(formatTodoProgressUpdate({
      item: first,
      completed: 1,
      total: 2,
      remaining: [second],
    }), 'Progress update: completed "Inspect the code" (1/2 checklist tasks complete). Continuing with "Verify the fix".');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
