# Message Bus

The message bus is Symbiote's nervous system. Every inbound message flows through it. It handles priority ordering, interrupt bypass, message coalescing, and backpressure — all in-process with zero external dependencies.

## Priority Levels

Every message is classified by the router before entering the bus:

| Priority | Weight | Behavior |
|----------|--------|----------|
| `interrupt` | 0 | **Bypasses the queue entirely.** Cancels the active agent turn via abort signal. Processed immediately. |
| `high` | 1 | Skips coalescing. Next in line after any active turn completes. |
| `normal` | 2 | Standard processing. Subject to coalescing. |
| `low` | 3 | Reactions, group mentions. Queued politely. |
| `background` | 4 | Typing indicators, presence updates. **Dropped under backpressure.** |

### Interrupt Detection

The router classifies messages as interrupts based on content patterns:

- Explicit stop words: `"stop"`, `"cancel"`, `"abort"`, `"halt"`
- Owner-sent messages while the agent is mid-turn
- System-level signals

When an interrupt fires, the abort signal propagates through the entire stack: agent runner → LLM stream → tool execution. The current turn ends immediately.

## Message Coalescing

When a user sends multiple messages in rapid succession, the bus merges them:

```
"hey"              → buffered (2s timer starts)
"can you"          → buffered (timer resets)
"check the logs"   → 2s timer expires → merged into one envelope
```

**Result:** One coherent request, one agent turn, no wasted tokens.

Coalescing respects priority — `high` and `interrupt` messages are never coalesced. Only `normal` and `low` messages from the same sender in the same session are eligible.

## Backpressure

Under load, the bus sheds `background` priority messages (typing indicators, presence updates) to protect agent throughput. Real messages never drop.

The backpressure threshold is based on queue depth. When the queue exceeds the configured limit:

1. `background` messages are silently dropped
2. `low` messages are delayed
3. `normal`, `high`, and `interrupt` messages proceed normally

## Subscriptions

The agent runner subscribes to sessions via the bus. When a message arrives for a session, the bus delivers it to the subscribed handler:

```typescript
bus.subscribe(sessionId, async (envelope: BusEnvelope) => {
  // Process the message through the agent runner
});
```

Multiple subscriptions per session are supported for monitoring (e.g., the Web UI's SSE stream).

## Envelope Format

Every message in the bus is wrapped in a `BusEnvelope`:

```typescript
interface BusEnvelope {
  id: string;              // Unique message ID
  sessionId: string;       // Target session
  source: ChannelSource;   // Origin channel + metadata
  content: string;         // Message text
  priority: MessagePriority;
  timestamp: number;
  coalesced?: string[];    // IDs of merged messages
}
```
