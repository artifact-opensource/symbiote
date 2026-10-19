import test from 'node:test';
import assert from 'node:assert/strict';
import { pythonCommandWithRequiredModule } from '../runtime/platform.js';

test('Python runtime selection finds an interpreter with the requested module', () => {
  const command = pythonCommandWithRequiredModule('browser-sidecar.py', 'sys');
  assert.equal(command.args.at(-1), 'browser-sidecar.py');
});

test('Python runtime selection gives install guidance when a module is unavailable', () => {
  assert.throws(
    () => pythonCommandWithRequiredModule('browser-sidecar.py', 'symbiote_missing_test_dependency'),
    /Install it for the selected Python, or set SYMBIOTE_PYTHON/,
  );
});
