import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityType, type Client } from 'discord.js';
import { PresenceManager } from '../channels/presence.js';

test('Discord presence reflects execution and response writing alongside other activity states', () => {
  const updates: Array<{ name?: string; type?: ActivityType; status?: string }> = [];
  let resumeActivity: (() => void) | undefined;
  const client = {
    isReady: () => true,
    on: (_event: unknown, listener: () => void) => { resumeActivity = listener; },
    once: () => undefined,
    user: {
      presence: { status: 'offline' },
      setActivity: (name: string, options?: { type: ActivityType }) => { updates.push({ name, ...options }); },
      setPresence: (presence?: { status?: string }) => { updates.push({ name: undefined, status: presence?.status }); },
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
  manager.toolStart('write');
  manager.toolStart('comb_recall');
  manager.llmStreaming('writing');
  resumeActivity?.();
  manager.endTurn(target);

  const states = updates.map(update => update.name);
  assert.deepEqual(states, [
    undefined,
    '🤔 Thinking...',
    '🧩 Reasoning...',
    '⚡ Executing...',
    '🔧 Using hardware...',
    '✏️ Editing...',
    '✍️ Writing...',
    '🧠 Recalling...',
    '✍️ Writing response...',
    '✍️ Writing response...',
    undefined,
  ]);
  assert.ok(updates.filter(update => update.name).every(update => update.type === ActivityType.Playing));
  assert.equal(updates[0].status, 'online');
  manager.stopAll();
});

test('exec activity returns to thinking after tool completion without a typing indicator', async () => {
  const updates: Array<string | undefined> = [];
  const client = {
    isReady: () => true,
    on: () => undefined,
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
  assert.equal(updates.at(-1), '⚡ Executing...');
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
