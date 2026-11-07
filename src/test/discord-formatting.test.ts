import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForChannel } from '../channels/formatter.js';
import type { ChannelCapabilities } from '../channels/types.js';

const discordCapabilities: ChannelCapabilities = {
  media: true,
  reactions: true,
  messageEdit: true,
  messageDelete: true,
  threads: true,
  embeds: true,
  components: true,
  voiceNotes: false,
  readReceipts: false,
  typingIndicator: true,
  ephemeral: true,
  polls: false,
  formatting: 'markdown',
  maxMessageLength: 2_000,
  maxMediaSize: 8_000_000,
  rateLimits: {},
};

test('Discord formatting preserves numeric values and Markdown code', () => {
  const response = '1. Value: **3917**\n\n```typescript\nconst answer = 3917;\n```';

  assert.deepEqual(formatForChannel(response, discordCapabilities), [response]);
});

test('Discord message splitting keeps fenced code blocks balanced and within the limit', () => {
  const response = `Use this code:\n\n\`\`\`typescript\n${'const answer = 3917;\n'.repeat(100)}\`\`\``;
  const chunks = formatForChannel(response, { ...discordCapabilities, maxMessageLength: 300 });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.ok(chunks.every((chunk) => (chunk.match(/```/g) ?? []).length % 2 === 0));
  assert.ok(chunks.slice(1).every((chunk) => chunk.startsWith('```typescript\n')));
});
