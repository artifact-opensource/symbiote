/**
 * Mach6 v2.0.0 — Lightweight Metrics Collector
 * 
 * Zero-dependency metrics collection for agent runtime observability.
 * Tracks: provider latency, token usage, tool call frequency, error rates,
 * session lifecycle, and system resource utilization.
 * 
 * Design principles:
 * - No external deps (uses Node.js stdlib only)
 * - Non-blocking (fire-and-forget recording)
 * - Bounded memory (ring buffers, automatic eviction)
 * - Persistent (periodic flush to JSON on disk)
 * 
 * @since 2.0.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProviderMetrics {
  name: string;
  totalCalls: number;
  totalErrors: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /** Latency histogram: p50, p90, p99 in ms */
  latency: { p50: number; p90: number; p99: number; avg: number; min: number; max: number };
  /** Last error message and timestamp */
  lastError?: { message: string; at: number };
  /** Last successful call timestamp */
  lastSuccess?: number;
  /** Error rate (0-1) over last 100 calls */
  errorRate: number;
}

export interface ToolMetrics {
  name: string;
  totalCalls: number;
  totalErrors: number;
  /** Average execution time in ms */
  avgDurationMs: number;
  /** Last call timestamp */
  lastCall?: number;
}

export interface SessionMetrics {
  totalCreated: number;
  totalArchived: number;
  activeSessions: number;
  avgMessagesPerSession: number;
  avgTokensPerSession: { input: number; output: number };
}

export interface SystemSnapshot {
  timestamp: number;
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    /** RSS as percentage of total system memory */
    rssPct: number;
  };
  cpuUsage: {
    user: number;
    system: number;
  };
  uptime: number;
  loadAvg: [number, number, number];
  freeMemPct: number;
}

export interface MetricsSnapshot {
  timestamp: number;
  uptime: number;
  version: string;
  providers: Record<string, ProviderMetrics>;
  tools: Record<string, ToolMetrics>;
  sessions: SessionMetrics;
  system: SystemSnapshot;
  turnCount: number;
  blinkCount: number;
  failoverCount: number;
}

// ── Ring Buffer for latency samples ────────────────────────────────────────

class RingBuffer {
  private buf: number[];
  private pos = 0;
  private full = false;

  constructor(private capacity: number) {
    this.buf = new Array(capacity).fill(0);
  }

  push(value: number): void {
    this.buf[this.pos] = value;
    this.pos = (this.pos + 1) % this.capacity;
    if (this.pos === 0) this.full = true;
  }

  values(): number[] {
    if (!this.full) return this.buf.slice(0, this.pos);
    return [...this.buf.slice(this.pos), ...this.buf.slice(0, this.pos)];
  }

  size(): number {
    return this.full ? this.capacity : this.pos;
  }

  percentile(p: number): number {
    const sorted = this.values().sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p / 100 * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  avg(): number {
    const vals = this.values();
    if (vals.length === 0) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  min(): number {
    const vals = this.values();
    return vals.length > 0 ? Math.min(...vals) : 0;
  }

  max(): number {
    const vals = this.values();
    return vals.length > 0 ? Math.max(...vals) : 0;
  }
}

// ── Error Rate Tracker (sliding window) ────────────────────────────────────

class ErrorRateTracker {
  private window: boolean[]; // true = success, false = error
  private pos = 0;
  private count = 0;

  constructor(private capacity = 100) {
    this.window = new Array(capacity).fill(true);
  }

  record(success: boolean): void {
    this.window[this.pos] = success;
    this.pos = (this.pos + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  rate(): number {
    if (this.count === 0) return 0;
    const slice = this.count < this.capacity ? this.window.slice(0, this.count) : this.window;
    const errors = slice.filter(s => !s).length;
    return errors / slice.length;
  }
}

// ── Provider Tracker ───────────────────────────────────────────────────────

class ProviderTracker {
  readonly name: string;
  totalCalls = 0;
  totalErrors = 0;
  totalTokensIn = 0;
  totalTokensOut = 0;
  lastError?: { message: string; at: number };
  lastSuccess?: number;
  private latencies = new RingBuffer(500);
  private errorRate = new ErrorRateTracker(100);

  constructor(name: string) {
    this.name = name;
  }

  recordCall(durationMs: number, tokensIn: number, tokensOut: number): void {
    this.totalCalls++;
    this.totalTokensIn += tokensIn;
    this.totalTokensOut += tokensOut;
    this.latencies.push(durationMs);
    this.errorRate.record(true);
    this.lastSuccess = Date.now();
  }

  recordError(message: string): void {
    this.totalCalls++;
    this.totalErrors++;
    this.lastError = { message, at: Date.now() };
    this.errorRate.record(false);
  }

  toMetrics(): ProviderMetrics {
    return {
      name: this.name,
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      totalTokensIn: this.totalTokensIn,
      totalTokensOut: this.totalTokensOut,
      latency: {
        p50: Math.round(this.latencies.percentile(50)),
        p90: Math.round(this.latencies.percentile(90)),
        p99: Math.round(this.latencies.percentile(99)),
        avg: Math.round(this.latencies.avg()),
        min: Math.round(this.latencies.min()),
        max: Math.round(this.latencies.max()),
      },
      lastError: this.lastError,
      lastSuccess: this.lastSuccess,
      errorRate: Math.round(this.errorRate.rate() * 1000) / 1000,
    };
  }
}

// ── Tool Tracker ───────────────────────────────────────────────────────────

class ToolTracker {
  readonly name: string;
  totalCalls = 0;
  totalErrors = 0;
  lastCall?: number;
  private durations = new RingBuffer(200);

  constructor(name: string) {
    this.name = name;
  }

  recordCall(durationMs: number, isError: boolean): void {
    this.totalCalls++;
    if (isError) this.totalErrors++;
    this.durations.push(durationMs);
    this.lastCall = Date.now();
  }

  toMetrics(): ToolMetrics {
    return {
      name: this.name,
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      avgDurationMs: Math.round(this.durations.avg()),
      lastCall: this.lastCall,
    };
  }
}

// ── Metrics Collector (Singleton) ──────────────────────────────────────────

export class MetricsCollector {
  private providers = new Map<string, ProviderTracker>();
  private tools = new Map<string, ToolTracker>();
  private startTime = Date.now();
  private turnCount = 0;
  private blinkCount = 0;
  private failoverCount = 0;
  private sessionsCreated = 0;
  private sessionsArchived = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private metricsDir: string;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = Date.now();
  private version: string;

  constructor(opts: { metricsDir?: string; flushIntervalMs?: number; version?: string } = {}) {
    this.metricsDir = opts.metricsDir ?? path.join(process.cwd(), '.mach6', 'metrics');
    this.version = opts.version ?? '2.0.0';
    fs.mkdirSync(this.metricsDir, { recursive: true });

    // Periodic flush to disk (every 5 minutes)
    const interval = opts.flushIntervalMs ?? 5 * 60 * 1000;
    this.flushTimer = setInterval(() => this.flush(), interval);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  // ── Recording Methods ────────────────────────────────────────────────

  recordProviderCall(name: string, durationMs: number, tokensIn: number, tokensOut: number): void {
    const tracker = this.getProvider(name);
    tracker.recordCall(durationMs, tokensIn, tokensOut);
  }

  recordProviderError(name: string, message: string): void {
    const tracker = this.getProvider(name);
    tracker.recordError(message);
  }

  recordToolCall(name: string, durationMs: number, isError: boolean): void {
    const tracker = this.getTool(name);
    tracker.recordCall(durationMs, isError);
  }

  recordTurn(): void {
    this.turnCount++;
  }

  recordBlink(): void {
    this.blinkCount++;
  }

  recordFailover(): void {
    this.failoverCount++;
  }

  recordSessionCreated(): void {
    this.sessionsCreated++;
  }

  recordSessionArchived(): void {
    this.sessionsArchived++;
  }

  // ── Snapshot ─────────────────────────────────────────────────────────

  snapshot(activeSessions = 0, avgMsgsPerSession = 0, avgTokensIn = 0, avgTokensOut = 0): MetricsSnapshot {
    const now = Date.now();
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();

    // Calculate CPU usage since last check
    const cpuNow = process.cpuUsage();
    const elapsed = (now - this.lastCpuTime) * 1000; // microseconds
    const userPct = elapsed > 0 ? ((cpuNow.user - this.lastCpuUsage.user) / elapsed) * 100 : 0;
    const sysPct = elapsed > 0 ? ((cpuNow.system - this.lastCpuUsage.system) / elapsed) * 100 : 0;
    this.lastCpuUsage = cpuNow;
    this.lastCpuTime = now;

    const providers: Record<string, ProviderMetrics> = {};
    for (const [name, tracker] of this.providers) {
      providers[name] = tracker.toMetrics();
    }

    const tools: Record<string, ToolMetrics> = {};
    for (const [name, tracker] of this.tools) {
      tools[name] = tracker.toMetrics();
    }

    return {
      timestamp: now,
      uptime: now - this.startTime,
      version: this.version,
      providers,
      tools,
      sessions: {
        totalCreated: this.sessionsCreated,
        totalArchived: this.sessionsArchived,
        activeSessions,
        avgMessagesPerSession: avgMsgsPerSession,
        avgTokensPerSession: { input: avgTokensIn, output: avgTokensOut },
      },
      system: {
        timestamp: now,
        memoryUsage: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          rssPct: Math.round((mem.rss / totalMem) * 10000) / 100,
        },
        cpuUsage: {
          user: Math.round(userPct * 100) / 100,
          system: Math.round(sysPct * 100) / 100,
        },
        uptime: process.uptime(),
        loadAvg: os.loadavg() as [number, number, number],
        freeMemPct: Math.round((os.freemem() / totalMem) * 10000) / 100,
      },
      turnCount: this.turnCount,
      blinkCount: this.blinkCount,
      failoverCount: this.failoverCount,
    };
  }

  // ── Flush to Disk ────────────────────────────────────────────────────

  flush(): void {
    try {
      const snap = this.snapshot();
      const filename = `metrics-${new Date().toISOString().slice(0, 10)}.jsonl`;
      const filepath = path.join(this.metricsDir, filename);
      fs.appendFileSync(filepath, JSON.stringify(snap) + '\n');

      // Rotate: keep only last 7 days of metrics
      this.rotateFiles(7);
    } catch {
      // Non-fatal — metrics are best-effort
    }
  }

  /** Read today's metrics from disk */
  readToday(): MetricsSnapshot[] {
    try {
      const filename = `metrics-${new Date().toISOString().slice(0, 10)}.jsonl`;
      const filepath = path.join(this.metricsDir, filename);
      if (!fs.existsSync(filepath)) return [];
      return fs.readFileSync(filepath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as MetricsSnapshot);
    } catch {
      return [];
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    this.flush();
  }

  // ── Private ──────────────────────────────────────────────────────────

  private getProvider(name: string): ProviderTracker {
    let tracker = this.providers.get(name);
    if (!tracker) {
      tracker = new ProviderTracker(name);
      this.providers.set(name, tracker);
    }
    return tracker;
  }

  private getTool(name: string): ToolTracker {
    let tracker = this.tools.get(name);
    if (!tracker) {
      tracker = new ToolTracker(name);
      this.tools.set(name, tracker);
    }
    return tracker;
  }

  private rotateFiles(keepDays: number): void {
    try {
      const files = fs.readdirSync(this.metricsDir).filter(f => f.startsWith('metrics-') && f.endsWith('.jsonl'));
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - keepDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      for (const file of files) {
        const dateStr = file.replace('metrics-', '').replace('.jsonl', '');
        if (dateStr < cutoffStr) {
          fs.unlinkSync(path.join(this.metricsDir, file));
        }
      }
    } catch {
      // Non-fatal
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _instance: MetricsCollector | null = null;

export function getMetrics(opts?: ConstructorParameters<typeof MetricsCollector>[0]): MetricsCollector {
  if (!_instance) {
    _instance = new MetricsCollector(opts);
  }
  return _instance;
}
