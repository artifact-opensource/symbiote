import assert from 'node:assert/strict';
import test from 'node:test';
import { createSseTextFilter } from '../web/sse-text-filter.js';

test('SSE text is suppressed while activity events remain immediate', () => {
  const events: Record<string, unknown>[] = [];
  const filter = createSseTextFilter(event => events.push(event));

  filter.emit({ type: 'text_delta', text: 'Answer ' });
  filter.emit({ type: 'tool_start', name: 'read' });
  filter.emit({ type: 'todo_update', text: 'Task complete; continuing.' });
  filter.emit({ type: 'text_delta', text: 'complete.' });

  assert.deepEqual(events, [
    { type: 'tool_start', name: 'read' },
    { type: 'todo_update', text: 'Task complete; continuing.' },
  ]);
  filter.emit({ type: 'text', content: 'Complete answer' });
  assert.deepEqual(events, [
    { type: 'tool_start', name: 'read' },
    { type: 'todo_update', text: 'Task complete; continuing.' },
  ]);
});
