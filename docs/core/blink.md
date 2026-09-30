# Blink — Seamless Session Continuation

**The iteration wall doesn't exist.**

When an agent approaches its iteration budget, Blink ensures continuity. Instead of dying with a "max iterations reached" message, the agent seamlessly rolls into a fresh budget — and the user never sees the seam.

## How It Works

1. **Prepare** — At `prepareAt` iterations remaining (default: 3), a system message tells the agent to keep working normally
2. **Blink** — The agent exhausts its budget. The daemon catches this, records the blink, and spawns a fresh turn on the same session
3. **Resume** — The new turn inherits the full conversation history. A resume message tells the agent its blink depth and total iteration count
4. **Repeat** — Up to `maxDepth` consecutive blinks (default: 5)

The user sees one continuous conversation. The iteration budget is the only thing that resets.

## Configuration

In `mach6.json`:

```json
{
  "blink": {
    "enabled": true,
    "maxDepth": 5,
    "prepareAt": 3,
    "cooldownMs": 1000,
    "checkpointInterval": 25
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable Blink |
| `maxDepth` | `5` | Max consecutive blinks per conversation |
| `prepareAt` | `3` | Inject preparation message at N iterations remaining |
| `cooldownMs` | `1000` | Delay between blink and resume (ms) |
| `checkpointInterval` | `25` | Inject checkpoint nudge every N iterations (0 = disabled) |

## Checkpoints

For long-running tasks, Blink injects periodic checkpoint messages (every `checkpointInterval` iterations). These nudge the agent to save critical state via `comb_stage`. If the session is externally killed (SIGTERM, OOM, crash), the last checkpoint ensures progress is recoverable.

Checkpoints don't interrupt work — they're advisory messages. The agent can ignore them if there's nothing critical to save.

## PULSE Integration

Blink is PULSE-aware. When [Pulse](pulse.md) expands the iteration cap mid-turn, Blink re-arms its preparation trigger to fire near the *new* wall, not the old one. This prevents premature preparation messages.

## Blink State

Each conversation tracks:

- **depth** — how many blinks have occurred
- **totalIterations** — cumulative across all blinks
- **totalToolCalls** — cumulative tool calls
- **phase** — `normal`, `prepare`, `blinking`, `resumed`, or `capped`
- **capExpansions** — how many times PULSE expanded the cap

## Design Philosophy

Symbiote was built for long-running autonomous tasks — code generation, research, multi-step workflows. A hard iteration wall is an artificial constraint that fragments work. Blink removes that constraint while maintaining safety (via `maxDepth`) and observability (via checkpoints and state tracking).

> Ported from Singularity's cortex/blink.py — same philosophy, TypeScript runtime.
