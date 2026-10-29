import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BlinkController } from '../agent/blink.js';
import { EXPANDED_CAP as PULSE_EXPANDED_CAP, PulseBudgetManager } from '../agent/pulse.js';

test('PULSE expands to 1000 and restores the configured baseline after sustained light use', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-pulse-'));
  try {
    const pulse = new PulseBudgetManager(directory);
    assert.equal(pulse.getEffectiveCap(), 100);
    pulse.recordSession(80);
    assert.equal(new PulseBudgetManager(directory).getEffectiveCap(), 1000);

    pulse.recordSession(39);
    pulse.recordSession(39);
    assert.equal(pulse.recordSession(39).effectiveCap, 100);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('PULSE respects a configured baseline below its expansion threshold', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-pulse-config-'));
  try {
    const pulse = new PulseBudgetManager(directory, 50);
    assert.equal(pulse.getEffectiveCap(), 50);
    pulse.recordSession(40);
    assert.equal(pulse.getEffectiveCap(), 1000);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('BLINK defaults to five passes and stops after the depth cap', () => {
  const blink = new BlinkController();
  for (let depth = 0; depth < 5; depth++) {
    assert.equal(blink.needsBlink(true), true);
    blink.recordBlink(100, 10);
  }
  assert.equal(blink.getState().depth, 5);
  assert.equal(blink.needsBlink(true), false);
  assert.equal(blink.getState().phase, 'capped');
  assert.equal(blink.shouldContinue(), false);
});

test('BLINK caps total iterations across PULSE-expanded passes', () => {
  const blink = new BlinkController();
  const turnLimit = PULSE_EXPANDED_CAP * 2;
  assert.equal(blink.getConfig().maxTotalIterations, turnLimit);
  assert.equal(blink.getRemainingIterations(), turnLimit);

  assert.equal(blink.needsBlink(true, PULSE_EXPANDED_CAP), true);
  blink.recordBlink(PULSE_EXPANDED_CAP, 10);
  assert.equal(blink.getRemainingIterations(), PULSE_EXPANDED_CAP);

  assert.equal(blink.needsBlink(true, PULSE_EXPANDED_CAP), false);
  blink.recordComplete(PULSE_EXPANDED_CAP, 10);
  assert.equal(blink.getState().totalIterations, turnLimit);
  assert.equal(blink.getState().phase, 'capped');
  assert.equal(blink.shouldContinue(), false);
});

test('BLINK replaces a non-finite depth with its safe default', () => {
  const blink = new BlinkController({ maxDepth: Number.POSITIVE_INFINITY });
  assert.equal(blink.getConfig().maxDepth, 5);
});

test('BLINK still honors an explicitly configured depth ceiling', () => {
  const blink = new BlinkController({ maxDepth: 2 });
  blink.recordBlink(100, 1);
  blink.recordBlink(100, 1);
  assert.equal(blink.needsBlink(true), false);
  assert.equal(blink.shouldContinue(), false);
});
