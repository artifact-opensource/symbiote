# Pulse — Adaptive Iteration Budget

Pulse dynamically adjusts the agent's iteration budget based on actual usage patterns. Short conversations stay lightweight. Long tasks automatically get more room.

## How It Works

| Scenario | What Happens |
|----------|-------------|
| Agent hits iteration 18 (of default 20) | Pulse expands the cap to 100 for that turn |
| Last 3 sessions all finished under 10 iterations | Pulse reverts the cap back to 20 |

This is automatic — no configuration needed. The agent doesn't know it's happening. The daemon manages the budget silently.

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_CAP` | 20 | Starting iteration budget |
| `EXPANDED_CAP` | 100 | Budget after expansion |
| `EXPAND_THRESHOLD` | 18 | Expand when this iteration is reached |
| `REVERT_WINDOW` | 3 | Check this many recent sessions |
| `REVERT_THRESHOLD` | 10 | If all recent sessions < this, revert |

## State Persistence

Pulse saves its state to `pulse-budget.json` in the sessions directory:

```json
{
  "effectiveCap": 100,
  "recentIterations": [45, 32, 18],
  "expandedAt": 1709640000000
}
```

This persists across restarts — the budget carries over. If the daemon reboots, Pulse remembers whether it expanded.

## Blink Integration

Pulse works with [Blink](blink.md). When Pulse expands the cap, it notifies Blink to re-arm its preparation trigger near the new wall. This prevents Blink from preparing for a wall that moved.

## Why Not Just Set a High Default?

A high default (e.g., 100) wastes API budget on short conversations — heartbeats, quick questions, simple commands. Most interactions finish in under 10 iterations. Pulse lets those stay cheap while automatically scaling up for complex tasks.

The philosophy: **start small, grow when needed, shrink back when the demand passes.**
