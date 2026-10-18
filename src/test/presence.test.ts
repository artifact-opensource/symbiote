import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityType, type Client } from 'discord.js';
import { PresenceManager } from '../channels/presence.js';

test('Discord presence omits tool execution and response-writing while preserving other activity states', () => {
  const updates: Array<{ name?: string; type?: ActivityType }> = [];
  const client = {
    isReady: () => true,
    once: () => undefined,
    user: {
      presence: { status: 'online' },
      setActivity: (name: string, options?: { type: ActivityType }) => { updates.push({ name, ...options }); },
      setPresence: () => { updates.push({ name: undefined }); },
    },
  } as unknown as Client;
  const manager = new PresenceManager();

  manager.registerDiscordClient('discord-main', client);
  manager.registerAdapter('discord-main', async () => undefined);
  const target = { adapterId: 'discord-main', chatId: 'channel' };
  manager.beginTurn(target);
  manager.llmStreaming('thinking');
  manager.llmStreaming('reasoning');
  manager.toolStart('exec');
  manager.toolStart('hardware');
  manager.toolStart('edit');
  manager.toolStart('comb_recall');
  manager.llmStreaming('idle');
  manager.endTurn(target);

  const states = updates.map(update => update.name);
  assert.deepEqual(states, [
    undefined,
    '🤔 Thinking...',
    '🧩 Reasoning...',
    '🔧 Using hardware...',
    '✏️ Editing...',
    '🧠 Recalling...',
    undefined,
  ]);
  assert.ok(updates.filter(update => update.name).every(update => update.type === ActivityType.Playing));
  manager.stopAll();
});

test('tool completion returns to thinking while the turn remains active without a typing indicator', async () => {
  const updates: Array<string | undefined> = [];
  const client = {
    isReady: () => true,
    once: () => undefined,
    user: {
      presence: { status: 'online' },
      setActivity: (name: string) => { updates.push(name); },
      setPresence: () => { updates.push(undefined); },
    },
  } as unknown as Client;
  const manager = new PresenceManager();
  manager.registerDiscordClient('discord-main', client);
  const target = { adapterId: 'discord-main', chatId: 'channel' };

  manager.beginTurn(target);
  manager.toolStart('exec');
  manager.toolEnd('exec');
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.equal(updates.at(-1), '🤔 Thinking...');
  manager.endTurn(target);
  assert.equal(updates.at(-1), undefined);
  manager.stopAll();
});

test('typing notifications are opt-in and do not start for thinking, reasoning, or tool activity', () => {
  const typingCalls: Array<{ chatId: string; durationMs?: number }> = [];
  const manager = new PresenceManager();
  const target = { adapterId: 'whatsapp-main', chatId: 'chat' };
  manager.registerAdapter(target.adapterId, async (chatId, durationMs) => {
    typingCalls.push({ chatId, durationMs });
  });

  manager.llmStreaming('thinking');
  manager.llmStreaming('reasoning');
  manager.toolStart('exec');
  assert.deepEqual(typingCalls, []);

  manager.startTyping(target);
  manager.llmStreaming('idle');
  assert.deepEqual(typingCalls, [{ chatId: 'chat', durationMs: Infinity }]);
  manager.stopTyping(target);
  assert.deepEqual(typingCalls, [
    { chatId: 'chat', durationMs: Infinity },
    { chatId: 'chat', durationMs: 0 },
  ]);
  manager.stopAll();
});
