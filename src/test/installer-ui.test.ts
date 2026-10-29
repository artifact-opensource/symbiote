import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startInstallerUi } from '../cli/installer-ui.js';

test('installer UI writes configuration to the requested data directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-installer-ui-'));
  const workspace = path.join(directory, 'workspace');
  fs.writeFileSync(path.join(directory, '.env'), 'OPENROUTER_API_KEY=provider-secret-test-value\nDISCORD_BOT_TOKEN=discord-secret-test-value\n');
  const server = await startInstallerUi(0, directory, false);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const defaultsResponse = await fetch(`${baseUrl}/api/defaults`);
    assert.equal(defaultsResponse.status, 200);
    const defaults = await defaultsResponse.json() as { defaults: Record<string, unknown> & { workspace: string } };
    assert.equal(defaults.defaults.workspace, workspace);
    assert.equal(defaults.defaults.providerApiKey, undefined);
    assert.equal(defaults.defaults.discordToken, undefined);
    assert.equal(defaults.defaults.hasProviderApiKey, true);
    assert.equal(defaults.defaults.hasDiscordToken, true);

    const rebindingDefaults = await new Promise<number>((resolve, reject) => {
      const request = http.get(baseUrl, { path: '/api/defaults', headers: { Host: `untrusted.example:${address.port}` } }, response => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once('error', reject);
    });
    assert.equal(rebindingDefaults, 403);

    const crossOriginSetup = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    assert.equal(crossOriginSetup.status, 403);

    const invalidJson = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(invalidJson.status, 400);

    const oversizedSetup = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ unused: 'x'.repeat(64 * 1024) }),
    });
    assert.equal(oversizedSetup.status, 413);

    const setupResponse = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
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
    const savedEnvironment = fs.readFileSync(result.envPath, 'utf8');
    assert.match(savedEnvironment, /OPENROUTER_API_KEY=provider-secret-test-value/);
    assert.match(savedEnvironment, /DISCORD_BOT_TOKEN=discord-secret-test-value/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('installer UI chooses an available loopback port when its preferred port is occupied', async () => {
  const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-installer-port-a-'));
  const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-installer-port-b-'));
  const firstServer = await startInstallerUi(0, firstDirectory, false);
  const firstAddress = firstServer.address();
  assert.ok(firstAddress && typeof firstAddress === 'object');
  let secondServer: Awaited<ReturnType<typeof startInstallerUi>> | undefined;
  try {
    secondServer = await startInstallerUi(firstAddress.port, secondDirectory, false);
    const secondAddress = secondServer.address();
    assert.ok(secondAddress && typeof secondAddress === 'object');
    assert.notEqual(secondAddress.port, firstAddress.port);
    const response = await fetch(`http://127.0.0.1:${secondAddress.port}/api/defaults`);
    assert.equal(response.status, 200);
  } finally {
    await Promise.all([firstServer, secondServer].filter(Boolean).map(server => new Promise<void>((resolve, reject) => {
      server!.close(error => error ? reject(error) : resolve());
    })));
    fs.rmSync(firstDirectory, { recursive: true, force: true });
    fs.rmSync(secondDirectory, { recursive: true, force: true });
  }
});
