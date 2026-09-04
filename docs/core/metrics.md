# Metrics Collector

Zero-dependency runtime observability: provider latency histograms, token usage, tool call stats, session lifecycle, and system resource snapshots. Added in v2.0.0, included in Symbiote v2.1.0.

## Overview

`MetricsCollector` (`src/metrics/collector.ts`) records agent runtime telemetry using Node.js stdlib only. Data is held in bounded in-memory structures and flushed to disk periodically as newline-delimited JSON (`.jsonl`).

**Design properties:**
- No external dependencies
- Non-blocking fire-and-forget recording
- Bounded memory via ring buffers and sliding windows
- Auto-rotating 7-day on-disk history

## Singleton Access

```typescript
import { getMetrics } from './metrics/collector';

const metrics = getMetrics({
  metricsDir: '.mach6/metrics',   // Optional. Default: <cwd>/.mach6/metrics
  flushIntervalMs: 300_000,       // Optional. Default: 5 minutes
  version: '2.1.0',               // Optional. Default: '2.0.0'
});
```

`getMetrics()` returns the same instance on every call (process-wide singleton). Pass options only on first call.

## What Gets Tracked

### Provider Metrics

Per provider, keyed by name (`'groq'`, `'anthropic'`, etc.):

| Field | Description |
|-------|-------------|
| `totalCalls` | Lifetime call count (successes + errors) |
| `totalErrors` | Error count |
| `totalTokensIn` | Cumulative input tokens |
| `totalTokensOut` | Cumulative output tokens |
| `latency` | Histogram: `p50`, `p90`, `p99`, `avg`, `min`, `max` (ms) |
| `errorRate` | Error fraction over the last 100 calls (0-1, sliding window) |
| `lastError` | `{ message, at }` for the most recent error |
| `lastSuccess` | Unix timestamp of last successful call |

**Latency ring buffer:** last **500 samples** per provider. Histogram percentiles are computed on demand from the sorted buffer.

**Error rate window:** last **100 calls** per provider (sliding window of boolean success/error records).

### Tool Metrics

Per tool, keyed by name:

| Field | Description |
|-------|-------------|
| `totalCalls` | Total invocations |
| `totalErrors` | Error count |
| `avgDurationMs` | Rolling average execution time |
| `lastCall` | Unix timestamp of last invocation |

**Duration ring buffer:** last **200 samples** per tool.

### Session Metrics

Aggregate session lifecycle counters:

| Field | Description |
|-------|-------------|
| `totalCreated` | Sessions created since process start |
| `totalArchived` | Sessions archived since process start |
| `activeSessions` | Passed in at snapshot time |
| `avgMessagesPerSession` | Passed in at snapshot time |
| `avgTokensPerSession` | `{ input, output }` passed in at snapshot time |

### System Snapshot

Captured inline at each `snapshot()` call:

| Field | Description |
|-------|-------------|
| `memoryUsage.rss` | Resident set size (bytes) |
| `memoryUsage.heapUsed` | V8 heap used (bytes) |
| `memoryUsage.heapTotal` | V8 heap total (bytes) |
| `memoryUsage.external` | External C++ memory (bytes) |
| `memoryUsage.rssPct` | RSS as % of total system RAM |
| `cpuUsage.user` | User CPU % since last snapshot call |
| `cpuUsage.system` | System CPU % since last snapshot call |
| `uptime` | Process uptime in seconds (`process.uptime()`) |
| `loadAvg` | `[1m, 5m, 15m]` OS load average |
| `freeMemPct` | Free system RAM as % |

### Top-Level Counters

| Field | Description |
|-------|-------------|
| `turnCount` | Agent conversation turns |
| `blinkCount` | Blink heartbeat ticks |
| `failoverCount` | Provider failover events |

## Recording API

```typescript
// Provider
metrics.recordProviderCall('groq', 843, 512, 1024); // name, durationMs, tokensIn, tokensOut
metrics.recordProviderError('groq', 'rate_limit');

// Tool
metrics.recordToolCall('exec', 220, false); // name, durationMs, isError

// Counters
metrics.recordTurn();
metrics.recordBlink();
metrics.recordFailover();
metrics.recordSessionCreated();
metrics.recordSessionArchived();
```

All recording methods are synchronous and non-blocking.

## Snapshots

```typescript
// Get current in-memory snapshot (not from disk)
const snap: MetricsSnapshot = metrics.snapshot(
  activeSessions,       // number
  avgMsgsPerSession,    // number
  avgTokensIn,          // number
  avgTokensOut          // number
);
```

`MetricsSnapshot` contains `timestamp`, `uptime`, `version`, `providers`, `tools`, `sessions`, `system`, plus the top-level counters.

## Flush to Disk

Metrics are flushed every **5 minutes** (default) to:

```
.mach6/metrics/metrics-YYYY-MM-DD.jsonl
```

Each flush appends one JSON line (one `MetricsSnapshot` object). Files are rotated after **7 days** — older `.jsonl` files are deleted automatically on each flush.

```typescript
// Force an immediate flush
metrics.flush();

// Read today's flushed snapshots from disk
const today: MetricsSnapshot[] = metrics.readToday();
```

## Lifecycle

```typescript
// Stop flush timer and perform a final flush before process exit
metrics.stop();
```

The flush timer is `unref()`'d — it does not prevent process exit.

## Ring Buffers

| Buffer | Class | Capacity | Used for |
|--------|-------|----------|----------|
| Provider latency | `RingBuffer` | 500 | p50/p90/p99/avg/min/max |
| Provider error rate | `ErrorRateTracker` | 100 | Sliding window error fraction |
| Tool duration | `RingBuffer` | 200 | Average execution time |

`RingBuffer` overwrites oldest samples when full. `ErrorRateTracker` uses a fixed boolean ring over the last N calls.

## Error Handling

`flush()` and `readToday()` are wrapped in `try/catch`. Metrics are best-effort — disk failures are silent and non-fatal.

---

*Added in v2.0.0 (Symbiote v2.1.0). Source: `src/metrics/collector.ts`.*
