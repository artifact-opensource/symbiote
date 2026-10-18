# Pulse — Adaptive Iteration Budget

Pulse dynamically adjusts the agent's iteration budget based on actual usage patterns. Short conversations stay lightweight. Long tasks automatically get more room.

## How It Works

| Scenario | What Happens |
|----------|-------------|
| Agent reaches 80 iterations (of the default 100) | Pulse expands the cap to 1,000 for that turn |
| Last 3 completed turns all finished under 40 iterations | Pulse reverts the effective cap to the configured baseline |

This is automatic — no configuration needed. The agent doesn't know it's happening. The daemon manages the budget silently.

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_CAP` | 100 | Default starting iteration budget; `maxIterations` config can set the baseline |
| `EXPANDED_CAP` | 1,000 | Budget after expansion |
| `EXPAND_THRESHOLD` | 80 | Expand when this iteration is reached (lower baselines expand at 80% of their cap) |
| `REVERT_WINDOW` | 3 | Check this many recent sessions |
| `REVERT_THRESHOLD` | 10 | If all recent sessions < this, revert |

## State Persistence

Pulse saves its state to `pulse-budget.json` in the sessions directory. The recent iteration history is recorded per completed turn:

```json
{
  "effectiveCap": 1000,
  "recentIterations": [245, 132, 80],
  "expandedAt": 1709640000000
}
```

This persists across restarts — the budget carries over. If the daemon reboots, Pulse remembers whether it expanded.

## Blink Integration

Pulse works with [Blink](blink.md). When Pulse expands the cap, it notifies Blink to re-arm its preparation trigger near the new wall. This prevents Blink from preparing for a wall that moved.

## Why Keep an Adaptive Starting Budget?

A high starting budget does not force extra provider calls: the runner exits as soon as the provider completes. It does, however, let sustained tasks continue without a continuation cycle. Pulse expands to 1,000 iterations for unusually long turns and retains that effective cap until three light turns indicate it can return to the configured baseline.

The philosophy: **finish the work, scale the budget to demand, and never confuse a budget boundary with task completion.**
