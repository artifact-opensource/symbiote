import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startInstallerUi } from '../cli/installer-ui.js';

test('installer UI writes configuration to the requested data directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-installer-ui-'));
  const workspace = path.join(directory, 'workspace');
  const server = await startInstallerUi(0, directory, false);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const defaultsResponse = await fetch(`${baseUrl}/api/defaults`);
    assert.equal(defaultsResponse.status, 200);
    const defaults = await defaultsResponse.json() as { defaults: { workspace: string } };
    assert.equal(defaults.defaults.workspace, workspace);

    const setupResponse = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, agentEnabled: false }),
    });
    assert.equal(setupResponse.status, 200);
    const result = await setupResponse.json() as { ok: boolean; configPath: string; envPath: string };
    assert.equal(result.ok, true);
    assert.equal(result.configPath, path.join(directory, 'symbiote.json'));
    assert.equal(result.envPath, path.join(directory, '.env'));
    assert.equal(fs.existsSync(result.configPath), true);
    assert.equal(fs.existsSync(result.envPath), true);
    assert.equal(JSON.parse(fs.readFileSync(result.configPath, 'utf8')).workspace, 'workspace');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
