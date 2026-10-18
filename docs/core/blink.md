# Blink — Continuous Iteration Continuation

**Per-invocation iteration limits do not impose a total continuation ceiling by default.**

When an agent approaches its iteration budget, Blink ensures continuity. Instead of dying with a "max iterations reached" message, the agent seamlessly rolls into a fresh budget — and the user never sees the seam.

## How It Works

1. **Prepare** — At `prepareAt` iterations remaining (default: 3), the runtime marks the current budget as prepared. This is internal state; it does not inject a synthetic user-visible message.
2. **Blink** — The agent exhausts its budget. The daemon catches this, records the blink, and spawns a fresh turn on the same session
3. **Resume** — The new turn inherits the full conversation history. A resume message tells the agent its blink depth and total iteration count
4. **Repeat** — Continue until the agent completes, the run is interrupted, or an operational failure prevents progress. The default `maxDepth` is unlimited; deployments may set an explicit ceiling.

The user sees one continuous conversation. The iteration budget is the only thing that resets.

## Continuation ceiling

Blink has no total-depth ceiling by default. An application embedding Blink can set an explicit ceiling when constructing the controller:

```typescript
const blink = new BlinkController({ maxDepth: 100 });
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable Blink |
| `maxDepth` | unlimited | Optional maximum consecutive blinks per conversation |
| `prepareAt` | `3` | Mark continuation preparation at N iterations remaining |
| `cooldownMs` | `1000` | Delay between blink and resume (ms) |
| `checkpointInterval` | `25` | Record an internal checkpoint marker every N iterations (0 = disabled) |

## Checkpoints

Every `checkpointInterval` iterations, Blink records an in-memory runtime checkpoint marker; it does not inject a message or call `comb_stage`. Separately, the runner calls its checkpoint callback after iterations so the gateway can persist conversation messages. A process restart does not resume an active turn automatically; the Control Room marks runs that were still active at startup as failed.

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

Symbiote can continue code generation, research, and multi-step workflows across multiple runner invocations without a default total-iteration or blink-depth cap. Interrupts, provider/tool failures, resource constraints, and process shutdown remain real stopping conditions. A process restart does not automatically resume the active turn.

> Ported from Singularity's cortex/blink.py — same philosophy, TypeScript runtime.
