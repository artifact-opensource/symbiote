import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolProgressBubble } from '../channels/progress-bubble.js';

test('progress bubble stays within Discord message limits and redacts sensitive headers', async () => {
  const sent: string[] = [];
  const edits: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return { messageId: 'progress-message' };
    },
    edit: async (_adapterId, _chatId, _messageId, content) => {
      edits.push(content);
    },
  }, 'discord-main', 'channel');

  await bubble.toolLine('exec', {
    command: 'curl -H "Authorization: Bearer discord-secret-value" https://example.test',
  });
  for (let i = 0; i < 100; i++) {
    await bubble.toolLine('exec', { command: `echo operational-check-${i}` });
  }
  await bubble.finalize();

  const messages = [...sent, ...edits];
  assert.ok(messages.length > 0);
  assert.ok(messages.every(message => message.length <= 2000));
  assert.ok(messages.every(message => !message.includes('discord-secret-value')));
  assert.match(edits.at(-1) ?? '', /Done — 101 tool calls/);
});
