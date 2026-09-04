# Boot Sequence

Symbiote starts with a structured boot sequence. Each step runs in order with a timeout. Non-critical steps degrade gracefully instead of crashing.

## Default Steps

| Step | Description | Timeout | Required |
|------|-------------|---------|----------|
| `config-load` | Load and parse `mach6.json` | 5s | ✅ Yes |
| `config-validate` | Validate all config fields | 5s | ✅ Yes |
| `comb-recall` | Recall operational memory | 15s | ❌ No |
| `hektor-warm` | Warm HEKTOR search index | 60s | ❌ No |
| `channel-connect` | Connect Discord, WhatsApp, HTTP | 30s | ❌ No |

## Failure Modes

| Status | Icon | Meaning |
|--------|------|---------|
| `ok` | `●` | Step completed successfully |
| `degraded` | `◐` | Non-required step failed — agent runs without it |
| `failed` | `✗` | Required step failed — boot aborted |
| `pending` | `○` | Skipped due to prior fatal error |

## Degraded Mode

If a non-required step fails (e.g., COMB recall times out, Discord connection fails), the agent enters **degraded mode**. It starts and operates normally, just without the failed subsystem. The boot output clearly shows which components degraded and why.

```
  ● [1/5] Loading configuration ... 12ms
  ● [2/5] Validating configuration ... 3ms
  ◐ [3/5] Recalling operational memory (COMB) degraded
    Timeout after 15000ms
  ● [4/5] Warming HEKTOR search index ... 450ms
  ● [5/5] Connecting channels ... 1200ms

  ◐ READY (degraded: comb-recall) — 1665ms
```

## Fatal Failure

If a required step fails (config load or validate), boot aborts. All subsequent steps are skipped and marked pending. The error message explains exactly what went wrong.

## Timeout Handling

Every step has an explicit timeout. If a step hangs (e.g., DNS resolution for a provider endpoint), the timeout catches it and the boot sequence continues with degradation instead of hanging indefinitely.

## Custom Boot Steps

You can create custom boot sequences by defining your own steps:

```typescript
import { runBootSequence, type BootStep } from './boot/sequence.js';

const steps: BootStep[] = [
  {
    name: 'my-step',
    description: 'Initialize custom subsystem',
    timeoutMs: 10_000,
    required: false,
    execute: async () => {
      // your init code
    },
  },
];

const { results, ready, degraded } = await runBootSequence(steps);
```

Each step receives branded terminal output — green dots for success, yellow for degraded, red for fatal — with millisecond timing.
