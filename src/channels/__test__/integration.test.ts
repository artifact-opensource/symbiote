/**
 * Symbiote — Channel System Integration Test
 * 
 * Tests the bus, router, and formatter together.
 * Run: npx tsx src/channels/__test__/integration.test.ts
 */

import { SymbioteBus } from '../bus.js';
import { InboundRouter } from '../router.js';
import { formatForChannel } from '../formatter.js';
import type { ChannelCapabilities, BusEnvelope, ChannelSource, InboundPayload } from '../types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

// ─── Test: Message Bus ─────────────────────────────────────────────────────

console.log('\n🔧 Message Bus');

{
  const bus = new SymbioteBus({ coalesceWindowMs: 0 }); // Disable coalesce for testing
  const received: BusEnvelope[] = [];

  bus.subscribe('session-1', (env) => received.push(env));

  // Publish a message
  bus.publish({
    id: '1',
    timestamp: Date.now(),
    priority: 'normal',
    source: { channelType: 'test', adapterId: 't1', chatId: 'c1', chatType: 'dm', senderId: 'u1' },
    sessionId: 'session-1',
    payload: { type: 'text', text: 'Hello' },
    metadata: {},
  });

  assert(received.length === 1, 'Normal message delivered');
  assert(received[0].payload.text === 'Hello', 'Message content preserved');

  // Test priority ordering
  received.length = 0;
  const bus2 = new SymbioteBus({ coalesceWindowMs: 0 });
  const ordered: string[] = [];

  // Publish low then high — high should deliver first when subscription is added
  bus2.publish({
    id: '2', timestamp: Date.now(), priority: 'low',
    source: { channelType: 'test', adapterId: 't1', chatId: 'c1', chatType: 'dm', senderId: 'u1' },
    sessionId: 's2', payload: { type: 'text', text: 'low' }, metadata: {},
  });
  bus2.publish({
    id: '3', timestamp: Date.now(), priority: 'high',
    source: { channelType: 'test', adapterId: 't1', chatId: 'c1', chatType: 'dm', senderId: 'u1' },
    sessionId: 's2', payload: { type: 'text', text: 'high' }, metadata: {},
  });

  bus2.subscribe('s2', (env) => ordered.push(env.payload.text!));
  assert(ordered[0] === 'high' && ordered[1] === 'low', 'Priority ordering works (high before low)');

  bus.destroy();
  bus2.destroy();
}

// ─── Test: Interrupt ───────────────────────────────────────────────────────

console.log('\n⚡ Interrupts');

{
  const bus = new SymbioteBus({ coalesceWindowMs: 0 });
  const interrupts: BusEnvelope[] = [];

  bus.onInterrupt('s3', (env) => interrupts.push(env));

  bus.publish({
    id: '4', timestamp: Date.now(), priority: 'interrupt',
    source: { channelType: 'test', adapterId: 't1', chatId: 'c1', chatType: 'dm', senderId: 'u1' },
    sessionId: 's3', payload: { type: 'text', text: 'STOP' }, metadata: {},
  });

  assert(interrupts.length === 1, 'Interrupt delivered to interrupt handler');
  assert(interrupts[0].payload.text === 'STOP', 'Interrupt content preserved');

  // Verify interrupt doesn't go into queue
  const drained = bus.drain('s3');
  assert(drained.length === 0, 'Interrupt bypasses queue (not in drain)');

  bus.destroy();
}

// ─── Test: Backpressure ────────────────────────────────────────────────────

console.log('\n🔴 Backpressure');

{
  let bpState = false;
  const bus = new SymbioteBus({
    maxQueueDepth: 5,
    coalesceWindowMs: 0,
    onBackpressure: (active) => { bpState = active; },
  });

  // Fill queue beyond max
  for (let i = 0; i < 8; i++) {
    bus.publish({
      id: `bp-${i}`, timestamp: Date.now(), priority: 'normal',
      source: { channelType: 'test', adapterId: 't1', chatId: 'c1', chatType: 'dm', senderId: 'u1' },
      sessionId: 'unsubscribed', // No subscriber → stays in queue
      payload: { type: 'text', text: `msg-${i}` }, metadata: {},
    });
  }

  assert(bpState as boolean === true, 'Backpressure activates at queue limit');

  // Background messages should be dropped under pressure
  const statsBefore = bus.stats();
  bus.publish({
    id: 'bg-drop', timestamp: Date.now(), priority: 'background',
    source: { channelType: 'test', adapterId: 't1', chatId: 'c1', chatType: 'dm', senderId: 'u1' },
    sessionId: 'unsubscribed', payload: { type: 'text', text: 'dropped' }, metadata: {},
  });
  const statsAfter = bus.stats();
  assert(statsAfter.totalDropped > statsBefore.totalDropped, 'Background messages dropped under backpressure');

  bus.destroy();
}

// ─── Test: Router Policy ───────────────────────────────────────────────────

console.log('\n🛡️  Router Policy');

{
  const bus = new SymbioteBus({ coalesceWindowMs: 0 });
  const router = new InboundRouter(bus, {
    policies: new Map([
      ['whatsapp', {
        dmPolicy: 'allowlist',
        groupPolicy: 'mention-only',
        allowedSenders: ['allowed-user'],
        ownerIds: ['owner-1'],
        selfId: 'bot-id',
      }],
    ]),
    globalOwnerIds: ['global-owner'],
  });

  const received: BusEnvelope[] = [];

  // We need to subscribe to catch routed messages
  // Router assigns session IDs, so we need to know them
  // Let's just check the return value for accept/reject

  const source: ChannelSource = {
    channelType: 'whatsapp', adapterId: 'wa-1', chatId: 'dm-1',
    chatType: 'dm', senderId: 'random-user',
  };
  const payload: InboundPayload = { type: 'text', text: 'hello' };

  // Random user DM → denied (allowlist mode)
  assert(router.route(source, payload, 'pol-1') === false, 'Random user blocked by allowlist');

  // Allowed user DM → accepted
  assert(router.route({ ...source, senderId: 'allowed-user' }, payload, 'pol-2') === true, 'Allowlisted user accepted');

  // Owner DM → accepted
  assert(router.route({ ...source, senderId: 'owner-1' }, payload, 'pol-3') === true, 'Owner always accepted');

  // Global owner → accepted
  assert(router.route({ ...source, senderId: 'global-owner' }, payload, 'pol-4') === true, 'Global owner accepted');

  // Group without mention → denied
  const groupSource: ChannelSource = {
    channelType: 'whatsapp', adapterId: 'wa-1', chatId: 'group-1',
    chatType: 'group', senderId: 'allowed-user', mentions: [],
  };
  assert(router.route(groupSource, payload, 'pol-5') === false, 'Group message without mention blocked');

  // Group with mention → accepted
  assert(
    router.route({ ...groupSource, mentions: ['bot-id'] }, payload, 'pol-6') === true,
    'Group message with @mention accepted',
  );

  bus.destroy();
}

// ─── Test: Deduplication ───────────────────────────────────────────────────

console.log('\n🔄 Deduplication');

{
  const bus = new SymbioteBus({ coalesceWindowMs: 0 });
  const router = new InboundRouter(bus, {
    policies: new Map([['test', { dmPolicy: 'open', groupPolicy: 'open', ownerIds: [] }]]),
  });

  const source: ChannelSource = {
    channelType: 'test', adapterId: 't1', chatId: 'c1', chatType: 'dm', senderId: 'u1',
  };
  const payload: InboundPayload = { type: 'text', text: 'hello' };

  assert(router.route(source, payload, 'msg-001') === true, 'First message accepted');
  assert(router.route(source, payload, 'msg-001') === false, 'Duplicate message rejected');
  assert(router.route(source, payload, 'msg-002') === true, 'Different message ID accepted');

  bus.destroy();
}

// ─── Test: Formatters ──────────────────────────────────────────────────────

console.log('\n📝 Formatters');

{
  const markdown = `# Title

**Bold text** and *italic text*.

| Col A | Col B |
|-------|-------|
| one   | two   |
| three | four  |

[Link](https://example.com)

\`\`\`typescript
const x = 1;
\`\`\``;

  // WhatsApp
  const waCaps: ChannelCapabilities = {
    media: true, reactions: true, messageEdit: false, messageDelete: true,
    threads: false, embeds: false, components: false, voiceNotes: true,
    readReceipts: true, typingIndicator: true, ephemeral: true, polls: true,
    formatting: 'whatsapp', maxMessageLength: 4096, maxMediaSize: 16 * 1024 * 1024,
    rateLimits: {},
  };
  const waResult = formatForChannel(markdown, waCaps);
  assert(!waResult[0].includes('# '), 'WhatsApp: headers converted (no #)');
  assert(!waResult[0].includes('**'), 'WhatsApp: bold converted (no **)');
  assert(waResult[0].includes('•'), 'WhatsApp: table converted to bullets');

  // Discord
  const discordCaps: ChannelCapabilities = {
    ...waCaps, formatting: 'markdown', maxMessageLength: 2000,
  };
  const discordResult = formatForChannel(markdown, discordCaps);
  assert(discordResult[0].includes('# Title'), 'Discord: headers preserved');
  assert(discordResult[0].includes('```'), 'Discord: tables become code blocks');

  // Telegram
  const tgCaps: ChannelCapabilities = {
    ...waCaps, formatting: 'html', maxMessageLength: 4096,
  };
  const tgResult = formatForChannel(markdown, tgCaps);
  assert(tgResult[0].includes('<b>'), 'Telegram: converted to HTML bold');
  assert(tgResult[0].includes('<a href='), 'Telegram: links converted to HTML');

  // Split test
  const longText = 'A'.repeat(5000);
  const discordSplit = formatForChannel(longText, discordCaps);
  assert(discordSplit.length > 1, 'Long message split for Discord (2000 limit)');
  assert(discordSplit.every(c => c.length <= 2000), 'All chunks within limit');
}

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${failed === 0 ? '🟢 All tests passed!' : '🔴 Some tests failed.'}\n`);

process.exit(failed > 0 ? 1 : 0);
