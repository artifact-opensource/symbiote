import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateContext } from '../agent/context.js';
import type { Message } from '../providers/types.js';

test('context truncation preserves the latest user message when older history does not fit', () => {
  const latest = 'Return 3917 and preserve `const answer = 3917;`.';
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old message '.repeat(100) },
    { role: 'assistant', content: 'old response '.repeat(100) },
    { role: 'user', content: latest },
  ];

  const result = truncateContext(messages, 30);

  assert.deepEqual(result.map((message) => message.content), ['sys', latest]);
});

test('context truncation keeps a bounded head and tail of an oversized latest user message', () => {
  const latest = `START 4937 ${'x'.repeat(1_000)} END \`const answer = 4937;\``;
  const result = truncateContext([
    { role: 'system', content: 'sys' },
    { role: 'user', content: latest },
  ], 100);
  const userMessage = result.find((message) => message.role === 'user');

  assert.ok(userMessage);
  if (typeof userMessage.content !== 'string') throw new TypeError('Expected a text message.');
  assert.match(userMessage.content, /^START 4937 /);
  assert.match(userMessage.content, /Middle of latest message omitted/);
  assert.match(userMessage.content, /END `const answer = 4937;`$/);
  assert.ok(result.reduce((sum, message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return sum + Math.ceil(content.length / 3);
  }, 0) <= 100);
});

test('context truncation reports when system messages leave no room for the latest user message', () => {
  assert.throws(
    () => truncateContext([
      { role: 'system', content: 'x'.repeat(300) },
      { role: 'user', content: 'Keep this request.' },
    ], 10),
    /System messages exceed the available model context window/,
  );
});
