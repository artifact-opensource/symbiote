# Circuit Breaker Failover

Provider health monitoring with automatic circuit breaking, latency-aware routing, and self-healing recovery. Added in v2.0.0, included in Symbiote v2.1.0.

## Overview

The `ProviderHealthMonitor` (`src/providers/health.ts`) sits alongside the existing provider fallback chain and adds:

- **Circuit breaker** — automatically disables a provider after consecutive failures, preventing wasted retries on a broken endpoint
- **Latency-aware routing** — when multiple providers are healthy, the fastest one is preferred
- **Auto-recovery** — circuit-open providers are probed automatically after a cooldown, without manual intervention
- **Observable state** — health history for every tracked provider, accessible via the `/api/v1/health` endpoint

## Health States

Each provider moves through four states:

| State | Meaning |
|-------|---------|
| `healthy` | Responding normally. Latency within threshold. |
| `degraded` | Responding but slow. Average latency exceeds `degradedLatencyMs` (default 30s). |
| `unhealthy` | 2+ consecutive failures but circuit not yet open. |
| `circuit-open` | Circuit tripped. Provider is disabled. Auto-recovery probe scheduled after cooldown. |

### State Transitions

```
healthy ←──────────────────── (2 consecutive successes)
   │                                    ↑
   │ latency > threshold          circuit-open
   ↓                                    ↑
degraded                                │ (cooldown elapsed → probe)
   │                                    │
   │ 2+ consecutive failures            │
   ↓                                    │
unhealthy ────────────────────────────→ (3 consecutive failures = circuit opens)
```

State transitions are automatic. No configuration or human intervention is required.

## Circuit Breaker Logic

**Opening the circuit:**
```
consecutive failures >= circuitBreakerThreshold (default: 3)
→ state = 'circuit-open'
→ circuitOpenedAt = now
→ provider skipped in failover chain
```

**Half-open probe (auto-recovery):**
```
(now - circuitOpenedAt) > circuitCooldownMs (default: 60s)
→ isAvailable() returns true (one probe request allowed)
→ if probe succeeds: consecutive success counter begins
→ if probe fails: circuitOpenedAt resets (cooldown restarts)
```

**Closing the circuit:**
```
consecutive successes >= circuitCloseThreshold (default: 2)
→ state = 'healthy'
→ circuitOpenedAt cleared
```

## Latency Tracking

Latency is tracked as a moving average over the last 20 calls (`LATENCY_WINDOW = 20`). Each `recordSuccess()` call updates the buffer:

```
pushLatency(name, latencyMs)  →  rolling window of last 20 samples
avgLatency = sum(window) / window.length
if avgLatency > degradedLatencyMs  →  state = 'degraded'
```

### Preferred Provider Ordering

`getPreferredOrder(providers)` returns providers sorted by:
1. State rank: `healthy` (0) → `degraded` (1) → `unhealthy` (2) → `circuit-open` (3)
2. Within the same state: sorted by ascending `avgLatencyMs`

Circuit-open providers that have not yet elapsed their cooldown are excluded entirely before sorting.

## ProviderHealth Interface

```typescript
interface ProviderHealth {
  name: string;
  state: ProviderHealthState;       // 'healthy' | 'degraded' | 'unhealthy' | 'circuit-open'
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  circuitOpenedAt?: number;         // Unix timestamp (ms) when circuit tripped
  lastSuccessAt?: number;           // Unix timestamp of last successful call
  lastFailureAt?: number;           // Unix timestamp of last failure
  lastError?: string;               // Last failure message
  avgLatencyMs: number;             // Rolling average over last 20 calls
  totalCalls: number;               // Lifetime call count for this instance
}
```

## Configuration

```typescript
const monitor = new ProviderHealthMonitor({
  circuitBreakerThreshold: 3,   // Failures before circuit opens (default: 3)
  circuitCooldownMs: 60_000,    // Cooldown before auto-recovery probe (default: 60s)
  circuitCloseThreshold: 2,     // Successes needed to close circuit (default: 2)
  degradedLatencyMs: 30_000,    // Latency threshold for 'degraded' state (default: 30s)
});
```

All four parameters are optional. Defaults cover typical production use.

## API

### Recording

```typescript
// After a successful provider call
monitor.recordSuccess('groq', 843);           // name, latencyMs

// After a provider error
monitor.recordFailure('groq', 'rate_limit');  // name, error message
```

### Querying

```typescript
// Is this provider available right now?
monitor.isAvailable('groq');                  // boolean

// Current state of a provider
monitor.getState('groq');                     // ProviderHealthState

// Full health struct for one provider
monitor.getProviderHealth('groq');            // ProviderHealth

// Health for all tracked providers
monitor.getAllHealth();                       // Record<string, ProviderHealth>

// Preferred order for a set of providers (healthiest + fastest first)
monitor.getPreferredOrder(['groq', 'anthropic', 'openai']); // string[]
```

## Integration with the Daemon

The health monitor integrates with `gateway/daemon.ts`'s existing fallback chain:

1. Before each provider call, `isAvailable(name)` is checked. Circuit-open providers are skipped.
2. After each call, `recordSuccess()` or `recordFailure()` is called with latency or error.
3. `getPreferredOrder()` drives provider selection when multiple are configured.
4. Provider health states are exposed in `GET /api/v1/health`.

## Observability

Health state is surfaced in the `/api/v1/health` response:

```json
{
  "providers": {
    "groq": {
      "state": "healthy",
      "avgLatencyMs": 843,
      "consecutiveFailures": 0,
      "totalCalls": 1204
    },
    "anthropic": {
      "state": "circuit-open",
      "avgLatencyMs": 0,
      "consecutiveFailures": 3,
      "circuitOpenedAt": 1741795200000,
      "lastError": "Connection timeout"
    }
  }
}
```

---

*Added in v2.0.0, included in Symbiote v2.1.0. Source: `src/providers/health.ts` (202 lines).*
