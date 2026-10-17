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

test('streamed channel reply is edited into the final response without a duplicate send', async () => {
  const sent: string[] = [];
  const edits: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return { messageId: 'live-reply' };
    },
    edit: async (_adapterId, _chatId, _messageId, content) => {
      edits.push(content);
    },
  }, 'discord-main', 'channel');

  await bubble.streamText('I found ');
  await bubble.toolLine('web_browse', { url: 'https://example.test' });
  await bubble.toolDone('web_browse');
  await bubble.streamText('the answer.');

  assert.equal(await bubble.finalize('<@user> I found the answer.'), true);
  assert.equal(sent.length, 1);
  assert.equal(edits.at(-1), '<@user> I found the answer.');
});

test('concurrent stream deltas create one message and coalesce edits', async () => {
  const sent: string[] = [];
  const edits: string[] = [];
  let releaseSend!: (result: { messageId: string }) => void;
  const firstSend = new Promise<{ messageId: string }>(resolve => { releaseSend = resolve; });
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return firstSend;
    },
    edit: async (_adapterId, _chatId, _messageId, content) => {
      edits.push(content);
    },
  }, 'discord-main', 'channel');

  const deltas = Array.from({ length: 100 }, (_, index) => bubble.streamText(`token-${index} `));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  const finalText = 'A single complete response.';
  const finalization = bubble.finalize(finalText);
  releaseSend({ messageId: 'live-reply' });
  assert.equal(await finalization, true);
  await Promise.all(deltas);
  assert.equal(sent.length, 1);
  assert.equal(edits.at(-1), finalText);
});

test('streaming stays disabled for adapters that cannot edit messages', async () => {
  const sent: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return null;
    },
    edit: null,
  }, 'read-only-adapter', 'channel');

  await bubble.streamText('This should use the normal delivery path.');
  assert.equal(await bubble.finalize('This should use the normal delivery path.'), false);
  assert.deepEqual(sent, []);
});

test('long final responses fall back instead of truncating the channel reply', async () => {
  const edits: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async () => ({ messageId: 'long-reply' }),
    edit: async (_adapterId, _chatId, _messageId, content) => { edits.push(content); },
  }, 'discord-main', 'channel');

  await bubble.streamText('Partial streamed content');
  assert.equal(await bubble.finalize('x'.repeat(1950)), false);
  assert.match(edits.at(-1) ?? '', /Done — 0 tool calls/);
  assert.ok(!(edits.at(-1) ?? '').includes('Partial streamed content'));
});
