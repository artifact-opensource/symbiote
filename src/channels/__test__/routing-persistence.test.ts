import test from 'node:test';
import assert from 'node:assert/strict';
import { SymbioteBus } from '../bus.js';
import { InboundRouter } from '../router.js';
import type { BusEnvelope, SessionRoute } from '../types.js';

test('interrupt envelopes reach interrupt subscribers without becoming prompts', () => {
  const bus = new SymbioteBus({ coalesceWindowMs: 0 });
  const normal: BusEnvelope[] = [];
  const interrupts: BusEnvelope[] = [];
  bus.subscribe('session-1', envelope => normal.push(envelope));
  bus.onInterrupt('session-1', envelope => interrupts.push(envelope));

  bus.publish({
    id: 'stop-1',
    timestamp: Date.now(),
    priority: 'interrupt',
    source: { channelType: 'test', adapterId: 'test-main', chatId: 'room-1', chatType: 'dm', senderId: 'owner' },
    sessionId: 'session-1',
    payload: { type: 'text', text: 'stop' },
    metadata: {},
  });

  assert.equal(interrupts.length, 1);
  assert.equal(normal.length, 0);
  assert.equal(bus.drain('session-1').length, 0);
  bus.destroy();
});

test('router restores adapter-specific sessions and excludes platform events', () => {
  const bus = new SymbioteBus({ coalesceWindowMs: 0 });
  const saved: SessionRoute[] = [];
  const router = new InboundRouter(bus, {
    policies: new Map([['test', { dmPolicy: 'open', groupPolicy: 'open', ownerIds: [] }]]),
    sessionRoutes: [{
      channelType: 'test',
      adapterId: 'test-main',
      chatId: 'room-1',
      sessionId: 'restored-session',
      lastActive: Date.now(),
    }],
    onSessionRoute: route => saved.push(route),
  });
  const received: BusEnvelope[] = [];
  bus.subscribe('restored-session', envelope => received.push(envelope));

  const source = {
    channelType: 'test',
    adapterId: 'test-main',
    chatId: 'room-1',
    chatType: 'dm' as const,
    senderId: 'user',
  };
  assert.equal(router.route(source, { type: 'text', text: 'hello' }, 'text-1'), true);
  assert.equal(received.length, 1);
  assert.equal(received[0].sessionId, 'restored-session');

  assert.equal(router.route(source, { type: 'reaction', reaction: { emoji: ':thumbs_up:', messageId: 'text-1' } }, 'reaction-1'), false);
  assert.equal(received.length, 1);

  assert.equal(router.route({ ...source, adapterId: 'test-secondary' }, { type: 'text', text: 'separate bot' }, 'text-2'), true);
  assert.equal(saved.length, 1);
  assert.notEqual(saved[0].sessionId, 'restored-session');
  bus.destroy();
});
