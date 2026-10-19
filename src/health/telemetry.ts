import * as fs from 'node:fs';
import * as path from 'node:path';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 50_000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HealthEventType =
  | 'gateway.started'
  | 'gateway.heartbeat'
  | 'gateway.stopped'
  | 'gateway.outage'
  | 'gateway.issue'
  | 'provider.call';

export interface HealthEvent {
  timestamp: number;
  type: HealthEventType;
  subsystem?: string;
  provider?: string;
  succeeded?: boolean;
  latencyMs?: number;
  message?: string;
  outageStartedAt?: number;
}

export interface HealthTelemetrySnapshot {
  generatedAt: number;
  windowMs: number;
  gateway: {
    score: number;
    trackedMs: number;
    uptimeMs: number;
    downtimeMs: number;
    issueCount: number;
    lastIncidentAt?: number;
  };
  providers: {
    score: number | null;
    calls: number;
    failures: number;
    byProvider: Record<string, { calls: number; failures: number }>;
  };
  recentEvents: HealthEvent[];
}

function isHealthEvent(value: unknown): value is HealthEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<HealthEvent>;
  return typeof event.timestamp === 'number'
    && Number.isFinite(event.timestamp)
    && ['gateway.started', 'gateway.heartbeat', 'gateway.stopped', 'gateway.outage', 'gateway.issue', 'provider.call'].includes(String(event.type));
}

function redactMessage(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted]')
    .slice(0, 240);
}

export class HealthTelemetryStore {
  private readonly filePath: string;
  private events: HealthEvent[];
  private cachedSnapshot: HealthTelemetrySnapshot | null = null;
  private cachedAt = 0;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.filePath = path.join(directory, 'health-events.jsonl');
    this.events = this.loadEvents();
  }

  record(event: Omit<HealthEvent, 'timestamp'> & { timestamp?: number }): HealthEvent {
    const stored: HealthEvent = {
      ...event,
      ...(event.message ? { message: redactMessage(event.message) } : {}),
      timestamp: event.timestamp ?? Date.now(),
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.events.push(stored);
    this.pruneInMemory(Date.now());
    this.cachedSnapshot = null;
    return stored;
  }

  getSnapshot(now = Date.now(), windowMs = DEFAULT_WINDOW_MS): HealthTelemetrySnapshot {
    if (this.cachedSnapshot && now - this.cachedAt < 1000 && this.cachedSnapshot.windowMs === windowMs) {
      return this.cachedSnapshot;
    }
    const start = now - windowMs;
    const windowEvents = this.events.filter(event => event.timestamp >= start && event.timestamp <= now);
    const lifecycleEvents = this.events.filter(event =>
      ['gateway.started', 'gateway.heartbeat', 'gateway.stopped', 'gateway.outage'].includes(event.type)
      && event.timestamp <= now,
    );
    const firstTrackedAt = Math.max(start, lifecycleEvents[0]?.timestamp ?? now);
    let online = false;
    let onlineSince = firstTrackedAt;
    let uptimeMs = 0;
    let downtimeMs = 0;
    let offlineSince = firstTrackedAt;

    for (const event of lifecycleEvents) {
      if (event.type === 'gateway.started') {
        if (!online && event.timestamp >= firstTrackedAt) {
          downtimeMs += Math.max(0, event.timestamp - offlineSince);
        }
        online = true;
        onlineSince = Math.max(firstTrackedAt, event.timestamp);
      } else if (event.type === 'gateway.stopped' && online) {
        const stoppedAt = Math.max(onlineSince, Math.min(now, event.timestamp));
        uptimeMs += Math.max(0, stoppedAt - onlineSince);
        online = false;
        offlineSince = stoppedAt;
      } else if (event.type === 'gateway.outage' && online) {
        const outageAt = Math.max(onlineSince, Math.min(now, event.outageStartedAt ?? event.timestamp));
        uptimeMs += Math.max(0, outageAt - onlineSince);
        downtimeMs += Math.max(0, Math.min(now, event.timestamp) - outageAt);
        online = false;
        offlineSince = Math.min(now, event.timestamp);
      }
    }

    if (online) uptimeMs += Math.max(0, now - onlineSince);
    else downtimeMs += Math.max(0, now - offlineSince);

    const trackedMs = Math.max(0, uptimeMs + downtimeMs);
    const issueEvents = windowEvents.filter(event => event.type === 'gateway.issue' || event.type === 'gateway.outage');
    const onlineHours = uptimeMs / (60 * 60 * 1000);
    const incidentReliability = onlineHours > 0 ? Math.exp(-issueEvents.length / onlineHours) : 1;
    const availability = trackedMs > 0 ? uptimeMs / trackedMs : 1;
    const gatewayScore = Math.round(100 * availability * incidentReliability);

    const byProvider: HealthTelemetrySnapshot['providers']['byProvider'] = {};
    for (const event of windowEvents) {
      if (event.type !== 'provider.call' || !event.provider) continue;
      const provider = byProvider[event.provider] ?? { calls: 0, failures: 0 };
      provider.calls++;
      if (!event.succeeded) provider.failures++;
      byProvider[event.provider] = provider;
    }
    const calls = Object.values(byProvider).reduce((total, provider) => total + provider.calls, 0);
    const failures = Object.values(byProvider).reduce((total, provider) => total + provider.failures, 0);

    this.cachedSnapshot = {
      generatedAt: now,
      windowMs,
      gateway: {
        score: gatewayScore,
        trackedMs,
        uptimeMs,
        downtimeMs,
        issueCount: issueEvents.length,
        ...(issueEvents.length ? { lastIncidentAt: issueEvents[issueEvents.length - 1].timestamp } : {}),
      },
      providers: {
        score: calls ? Math.round(((calls - failures) / calls) * 100) : null,
        calls,
        failures,
        byProvider,
      },
      recentEvents: windowEvents
        .filter(event => event.type !== 'gateway.heartbeat')
        .slice(-100)
        .reverse(),
    };
    this.cachedAt = now;
    return this.cachedSnapshot;
  }

  private loadEvents(): HealthEvent[] {
    let contents: string;
    try {
      contents = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const cutoff = Date.now() - RETENTION_MS;
    const valid: HealthEvent[] = [];
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isHealthEvent(parsed)) {
          if (parsed.timestamp >= cutoff) valid.push(parsed);
        } else {
          console.warn(`[health] Ignoring malformed telemetry record at line ${index + 1}.`);
        }
      } catch (error) {
        console.warn(`[health] Ignoring invalid telemetry JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.events = valid.slice(-MAX_EVENTS);
    if (valid.length !== this.events.length || contents.split(/\r?\n/).filter(Boolean).length !== valid.length) {
      this.persistCurrentEvents();
    }
    return this.events;
  }

  private pruneInMemory(now: number): void {
    const cutoff = now - RETENTION_MS;
    this.events = this.events.filter(event => event.timestamp >= cutoff).slice(-MAX_EVENTS);
    if (this.events.length === MAX_EVENTS || this.events.length % 500 === 0) {
      this.persistCurrentEvents();
    }
  }

  private persistCurrentEvents(): void {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, this.events.map(event => JSON.stringify(event)).join('\n') + (this.events.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }
}
