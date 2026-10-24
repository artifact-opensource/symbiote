import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireGatewayInstanceLock } from '../gateway/instance-lock.js';

test('only one Gateway can hold the same workspace lock', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-gateway-lock-'));
  try {
    const release = acquireGatewayInstanceLock(workspace);
    assert.throws(
      () => acquireGatewayInstanceLock(workspace),
      /A Symbiote Gateway is already running/,
    );
    release();
    assert.equal(fs.existsSync(path.join(workspace, '.session', 'gateway-instance.lock')), false);

    const nextRelease = acquireGatewayInstanceLock(workspace);
    nextRelease();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a lock left by a dead Gateway process can be reclaimed', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-gateway-stale-lock-'));
  const lockPath = path.join(workspace, '.session', 'gateway-instance.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2_000_000_000,
    token: 'stale-lock',
    startedAt: Date.now() - 60_000,
  }));

  try {
    const release = acquireGatewayInstanceLock(workspace);
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
