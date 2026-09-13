/**
 * Mach6 v2.0.0 — Provider Health Monitor
 * 
 * Tracks provider health over time and provides intelligent failover
 * recommendations. Works alongside the existing fallback chain in daemon.ts
 * to add:
 * - Circuit breaker pattern (disable provider after N consecutive failures)
 * - Latency-aware routing (prefer faster providers when all are healthy)
 * - Auto-recovery (re-enable providers after cooldown period)
 * - Health history for observability
 * 
 * @since 2.0.0
 */

export type ProviderHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'circuit-open';

export interface ProviderHealth {
  name: string;
  state: ProviderHealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Timestamp when circuit was opened (provider disabled) */
  circuitOpenedAt?: number;
  /** Timestamp of last successful call */
  lastSuccessAt?: number;
  /** Timestamp of last failure */
  lastFailureAt?: number;
  /** Last error message */
  lastError?: string;
  /** Moving average latency (ms) */
  avgLatencyMs: number;
  /** Total calls tracked in this lifecycle */
  totalCalls: number;
}

export interface HealthMonitorConfig {
  /** Number of consecutive failures before opening circuit (default: 3) */
  circuitBreakerThreshold?: number;
  /** Cooldown in ms before retrying a circuit-open provider (default: 60000) */
  circuitCooldownMs?: number;
  /** Number of consecutive successes to close circuit (default: 2) */
  circuitCloseThreshold?: number;
  /** Latency threshold in ms — above this = degraded (default: 30000) */
  degradedLatencyMs?: number;
}

const DEFAULT_CONFIG: Required<HealthMonitorConfig> = {
  circuitBreakerThreshold: 3,
  circuitCooldownMs: 60_000,
  circuitCloseThreshold: 2,
  degradedLatencyMs: 30_000,
};

export class ProviderHealthMonitor {
  private health = new Map<string, ProviderHealth>();
  private config: Required<HealthMonitorConfig>;
  private latencyBuffers = new Map<string, number[]>(); // Last N latencies
  private static readonly LATENCY_WINDOW = 20;

  constructor(config?: HealthMonitorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Recording ────────────────────────────────────────────────────────

  /** Record a successful provider call */
  recordSuccess(name: string, latencyMs: number): void {
    const h = this.getHealth(name);
    h.consecutiveFailures = 0;
    h.consecutiveSuccesses++;
    h.lastSuccessAt = Date.now();
    h.totalCalls++;

    // Update latency
    this.pushLatency(name, latencyMs);
    h.avgLatencyMs = this.getAvgLatency(name);

    // State transitions
    if (h.state === 'circuit-open' && h.consecutiveSuccesses >= this.config.circuitCloseThreshold) {
      h.state = 'healthy';
      h.circuitOpenedAt = undefined;
      console.log(`[health] ${name}: circuit CLOSED — back to healthy after ${h.consecutiveSuccesses} successes`);
    } else if (h.state === 'unhealthy') {
      h.state = h.avgLatencyMs > this.config.degradedLatencyMs ? 'degraded' : 'healthy';
    } else if (h.state !== 'circuit-open') {
      h.state = h.avgLatencyMs > this.config.degradedLatencyMs ? 'degraded' : 'healthy';
    }
  }

  /** Record a provider failure */
  recordFailure(name: string, error: string): void {
    const h = this.getHealth(name);
    h.consecutiveFailures++;
    h.consecutiveSuccesses = 0;
    h.lastFailureAt = Date.now();
    h.lastError = error;
    h.totalCalls++;

    // Circuit breaker: open circuit after threshold
    if (h.consecutiveFailures >= this.config.circuitBreakerThreshold && h.state !== 'circuit-open') {
      h.state = 'circuit-open';
      h.circuitOpenedAt = Date.now();
      console.log(`[health] ${name}: circuit OPEN — ${h.consecutiveFailures} consecutive failures. Cooldown: ${this.config.circuitCooldownMs}ms`);
    } else if (h.state !== 'circuit-open') {
      h.state = h.consecutiveFailures >= 2 ? 'unhealthy' : 'degraded';
    }
  }

  // ── Querying ─────────────────────────────────────────────────────────

  /** Check if a provider is available for use */
  isAvailable(name: string): boolean {
    const h = this.health.get(name);
    if (!h) return true; // Unknown provider = assume healthy

    if (h.state === 'circuit-open') {
      // Check if cooldown has elapsed
      if (h.circuitOpenedAt && (Date.now() - h.circuitOpenedAt) > this.config.circuitCooldownMs) {
        // Allow one probe request (half-open)
        return true;
      }
      return false;
    }
    return true;
  }

  /** Get health state for a provider */
  getState(name: string): ProviderHealthState {
    return this.health.get(name)?.state ?? 'healthy';
  }

  /** Get full health info for a provider */
  getProviderHealth(name: string): ProviderHealth {
    return this.getHealth(name);
  }

  /** Get health for all tracked providers */
  getAllHealth(): Record<string, ProviderHealth> {
    const result: Record<string, ProviderHealth> = {};
    for (const [name, health] of this.health) {
      result[name] = { ...health };
    }
    return result;
  }

  /** Get ordered list of available providers (healthiest first, then by latency) */
  getPreferredOrder(providers: string[]): string[] {
    const stateOrder: Record<ProviderHealthState, number> = {
      'healthy': 0,
      'degraded': 1,
      'unhealthy': 2,
      'circuit-open': 3,
    };

    return [...providers]
      .filter(p => this.isAvailable(p))
      .sort((a, b) => {
        const ha = this.getHealth(a);
        const hb = this.getHealth(b);
        // Sort by state first, then by latency
        const stateDiff = stateOrder[ha.state] - stateOrder[hb.state];
        if (stateDiff !== 0) return stateDiff;
        return ha.avgLatencyMs - hb.avgLatencyMs;
      });
  }

  // ── Private ──────────────────────────────────────────────────────────

  private getHealth(name: string): ProviderHealth {
    let h = this.health.get(name);
    if (!h) {
      h = {
        name,
        state: 'healthy',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        avgLatencyMs: 0,
        totalCalls: 0,
      };
      this.health.set(name, h);
    }
    return h;
  }

  private pushLatency(name: string, ms: number): void {
    let buf = this.latencyBuffers.get(name);
    if (!buf) {
      buf = [];
      this.latencyBuffers.set(name, buf);
    }
    buf.push(ms);
    if (buf.length > ProviderHealthMonitor.LATENCY_WINDOW) {
      buf.shift();
    }
  }

  private getAvgLatency(name: string): number {
    const buf = this.latencyBuffers.get(name);
    if (!buf || buf.length === 0) return 0;
    return Math.round(buf.reduce((a, b) => a + b, 0) / buf.length);
  }
}
