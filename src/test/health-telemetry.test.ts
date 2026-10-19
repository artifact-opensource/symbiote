import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthTelemetryStore } from '../health/telemetry.js';
import { ProviderHealthMonitor } from '../providers/health.js';

test('health telemetry persists provider call outcomes and calculates rolling reliability', () => {
  const directory = mkdtempSync(join(tmpdir(), 'symbiote-health-'));
  try {
    const store = new HealthTelemetryStore(directory);
    const monitor = new ProviderHealthMonitor(undefined, event => store.record({
      type: 'provider.call',
      provider: event.provider,
      succeeded: event.succeeded,
      ...(event.error ? { message: event.error } : {}),
    }));
    monitor.recordSuccess('test-provider', 120);
    monitor.recordFailure('test-provider', 'request failed');

    const snapshot = new HealthTelemetryStore(directory).getSnapshot();
    assert.equal(snapshot.providers.calls, 2);
    assert.equal(snapshot.providers.failures, 1);
    assert.equal(snapshot.providers.score, 50);
    assert.equal(snapshot.providers.byProvider['test-provider'].calls, 2);
    assert.equal(readFileSync(join(directory, 'health-events.jsonl'), 'utf8').trim().split(/\r?\n/).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('health telemetry counts clean uptime, outage downtime, and incidents in the rolling window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'symbiote-health-window-'));
  try {
    const store = new HealthTelemetryStore(directory);
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    const start = now - 4 * hour;
    store.record({ type: 'gateway.started', timestamp: start });
    store.record({ type: 'gateway.stopped', timestamp: start + hour });
    store.record({ type: 'gateway.started', timestamp: start + 2 * hour });
    store.record({ type: 'gateway.issue', timestamp: start + 3 * hour, subsystem: 'test', message: 'test failure' });
    store.record({ type: 'gateway.heartbeat', timestamp: now });

    const snapshot = store.getSnapshot(now);
    assert.equal(snapshot.gateway.uptimeMs, 3 * hour);
    assert.equal(snapshot.gateway.downtimeMs, hour);
    assert.equal(snapshot.gateway.trackedMs, 4 * hour);
    assert.equal(snapshot.gateway.issueCount, 1);
    assert.ok(snapshot.gateway.score > 50 && snapshot.gateway.score < 60);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
