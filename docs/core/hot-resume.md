# Session Hot Resume

Automatic session persistence and recovery across gateway restarts. Added in v2.0.0.

## Overview

`HotResumeManager` checkpoints active sessions to disk periodically and on clean exit. When the gateway restarts, sessions are restored transparently — users experience no interruption.

## How It Works

1. **Periodic Checkpoints** — Every 60 seconds, all active sessions are serialized to `.symbiote/hot-resume.json`
2. **Clean Exit Save** — On SIGTERM/SIGINT, a final checkpoint is written before the process exits
3. **Boot Restore** — On startup, the manager reads the checkpoint file and restores sessions into the session manager
4. **Pending Messages** — Messages that arrived during downtime are re-queued for processing

## What Gets Persisted

Each session snapshot includes:

| Field | Description |
|-------|-------------|
| `sessionId` | Unique session identifier |
| `channelType` | discord, whatsapp, webchat, api |
| `adapterId` | Which adapter owns the session |
| `messages` | Full conversation history |
| `provider` | Active LLM provider name |
| `model` | Active model name |
| `createdAt` | Session creation timestamp |
| `lastActiveAt` | Last message timestamp |

## State File

Default location: `.symbiote/hot-resume.json`

```json
{
  "timestamp": "2026-03-12T08:17:00.000Z",
  "sessions": [
    {
      "sessionId": "abc123",
      "channelType": "whatsapp",
      "messages": [...],
      "provider": "github-copilot",
      "model": "claude-opus-4.6"
    }
  ]
}
```

## Class: HotResumeManager

```typescript
import { HotResumeManager } from '../sessions/hot-resume.js';

const manager = new HotResumeManager(sessionManager, {
  checkpointIntervalMs: 60_000,  // default: 60s
  statePath: '.symbiote/hot-resume.json'
});

await manager.start();   // begin periodic checkpoints
await manager.stop();    // final save + stop timer
await manager.restore(); // load sessions from disk (called on boot)
```

## Integration

The gateway daemon initializes `HotResumeManager` during boot and calls `restore()` before accepting connections. The manager registers process exit handlers for clean saves.

*Source: `src/sessions/hot-resume.ts` (193 lines).*
