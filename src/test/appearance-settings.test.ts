import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppearanceSettingsStore } from '../appearance/settings.js';

test('appearance settings persist across store instances in the workspace data directory', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-appearance-'));
  try {
    const first = new AppearanceSettingsStore(workspace);
    assert.equal(first.isInitialized(), false);
    assert.deepEqual(first.read(), { brightness: 100, primaryHue: 145, secondaryHue: 13 });
    assert.deepEqual(first.write({ brightness: 0, primaryHue: 280, secondaryHue: 42 }), {
      brightness: 0,
      primaryHue: 280,
      secondaryHue: 42,
    });
    assert.equal(first.isInitialized(), true);
    assert.deepEqual(new AppearanceSettingsStore(workspace).read(), {
      brightness: 0,
      primaryHue: 280,
      secondaryHue: 42,
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('appearance settings reject non-finite and out-of-range values', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-appearance-invalid-'));
  try {
    const store = new AppearanceSettingsStore(workspace);
    assert.throws(() => store.write({ brightness: Number.NaN, primaryHue: 10, secondaryHue: 20 }), /from 0 to 100/);
    assert.throws(() => store.write({ brightness: 10, primaryHue: 361, secondaryHue: 20 }), /from 0 to 100/);
    assert.equal(fs.existsSync(path.join(workspace, '.agents', 'appearance.json')), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
