# Context Monitor

Real-time token tracking with progressive warnings and automatic compaction. Prevents agents from hitting context window limits by managing overflow before it happens.

## How It Works

The context monitor tracks estimated token usage across the conversation and takes automatic action at three thresholds:

| Threshold | Level | Action |
|-----------|-------|--------|
| **70%** | ⚠️ Warning | Logs a warning. No modification. |
| **80%** | 🔄 Compacting | Stages context to COMB, then summarizes old messages. Keeps system prompt + recent 40%. |
| **90%** | 🚨 Emergency | Saves full transcript to disk, hard-truncates to last 10 messages. |

## Architecture

```
Every Agent Turn:
  messages[] → ContextMonitor.manage() → messages[] (possibly compacted)
                    ↓
              check thresholds
                    ↓
         ok → pass through unchanged
         warning → log, pass through
         compacting → COMB stage + summarize old messages
         emergency → save transcript + hard truncate
```

### Token Estimation

Tokens are estimated at ~4 characters per token. This is a rough heuristic that works across most LLM tokenizers without requiring model-specific tokenization libraries.

For structured message content (tool calls, multi-part messages), the monitor estimates based on JSON serialization length, with a 50-token floor for unrecognizable blocks.

## Compaction

When the context hits 80%, the monitor performs intelligent compaction:

1. **COMB stage** — the current conversation is summarized and staged via `comb_stage` so the next session retains the context
2. **System prompt preserved** — system messages are never compacted
3. **Summary injection** — old messages are replaced with a condensed summary (max 2000 chars)
4. **Recent messages kept** — the most recent 40% of non-system messages are preserved verbatim

This means the agent keeps its instructions and recent context while older conversation history is compressed.

## Emergency Flush

At 90%, the monitor takes aggressive action:

1. **Transcript saved** — the full conversation is written to `{transcriptDir}/transcript-{timestamp}.json` for recovery
2. **Hard truncate** — only the system prompt and last 10 messages are kept
3. **Notice injected** — a marker message tells the agent that earlier context was flushed

The default transcript directory is `$TMPDIR/symbiote-transcripts`.

## Configuration

```typescript
const monitor = new ContextMonitor({
  maxContextTokens: 128000,    // Model's context window
  warnThreshold: 0.7,          // 70% — log warning
  compactThreshold: 0.8,       // 80% — auto-compact
  emergencyThreshold: 0.9,     // 90% — emergency flush
  transcriptDir: '/path/to/transcripts',
  onCombStage: async (content) => { /* COMB integration */ },
});
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxContextTokens` | required | Model's context window size |
| `warnThreshold` | `0.7` | Usage ratio to trigger warning |
| `compactThreshold` | `0.8` | Usage ratio to trigger compaction |
| `emergencyThreshold` | `0.9` | Usage ratio to trigger emergency flush |
| `transcriptDir` | `$TMPDIR/symbiote-transcripts` | Where to save emergency transcripts |

## Usage

The context monitor is called by the agent runner on every turn:

```typescript
// Check without modifying
const status = monitor.check(messages);
// status.health: 'ok' | 'warning' | 'compacting' | 'emergency'
// status.usage: 0.0–1.0
// status.totalTokens: estimated token count
// status.messageCount: number of messages

// Check and act (returns possibly compacted messages)
const managed = await monitor.manage(messages);
```

## Relationship to Blink and Pulse

The context monitor works alongside [Blink](blink.md) and [Pulse](pulse.md):

| System | Manages | Mechanism |
|--------|---------|-----------|
| **Context Monitor** | Token usage *within* a turn | Compaction, truncation |
| **Blink** | Iteration budget *across* turns | Spawns fresh turns seamlessly |
| **Pulse** | Iteration budget *sizing* | Adapts budget based on demand |

Together, they ensure the agent never hits a hard wall on either tokens or iterations.

---

*Added in v1.7.0*
