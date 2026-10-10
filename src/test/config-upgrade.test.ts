import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeConfig, upgradeConfigFile } from '../config/upgrade.js';
import { buildConfigTemplate, CONFIG_VERSION } from '../config/template.js';
import { validateConfig } from '../config/validator.js';
import { buildEnvFile, defaultSetupInput } from '../cli/setup.js';

const legacy = (dir: string) => ({
  defaultProvider: 'openrouter',
  defaultModel: 'openrouter/free',
  workspace: dir,
  ownerIds: '123',
  mach6: { legacy: true },
  providers: { openrouter: { apiKey: 'sk-or-inline-secret-value' }, groq: { apiKey: '${GROQ_API_KEY}' } },
  discord: { enabled: true, token: 'inline-discord-token-value', botId: '${DISCORD_CLIENT_ID}' },
  allowedOrigins: ['http://localhost:3009', 'http://localhost:3009'],
  notes: '',
});

test('upgrade fills every stub, relativizes paths and removes legacy keys', () => {
  const dir = path.resolve('some', 'project');
  const { config, changes } = upgradeConfig(legacy(dir), { configDir: dir });
  assert.equal(config.configVersion, CONFIG_VERSION);
  assert.equal(config.workspace, '.');
  assert.deepEqual(config.ownerIds, ['123']);
  assert.ok(!('mach6' in config) && !('notes' in config));
  assert.deepEqual(config.allowedOrigins, ['http://localhost:3009']);
  for (const key of ['heartbeat', 'timeouts', 'tools', 'whatsapp', 'orchestrator', 'adaptiveTemperature']) assert.ok(key in config, key);
  assert.ok(changes.length > 0);
});

test('upgrade moves inline secrets to env references', () => {
  const dir = path.resolve('some', 'project');
  const { config, secrets } = upgradeConfig(legacy(dir), { configDir: dir });
  assert.equal(config.providers.openrouter.apiKey, '${OPENROUTER_API_KEY}');
  assert.equal(config.discord.token, '${DISCORD_BOT_TOKEN}');
  assert.equal(secrets.OPENROUTER_API_KEY, 'sk-or-inline-secret-value');
  assert.equal(secrets.DISCORD_BOT_TOKEN, 'inline-discord-token-value');
});

test('upgrade never overwrites a conflicting .env value', () => {
  const dir = path.resolve('some', 'project');
  const { config, secrets } = upgradeConfig(legacy(dir), { configDir: dir, existingEnv: { OPENROUTER_API_KEY: 'different-key' } });
  assert.equal(config.providers.openrouter.apiKey, 'sk-or-inline-secret-value');
  assert.equal(secrets.OPENROUTER_API_KEY, undefined);
});

test('upgrade is idempotent on disk and keeps a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-upgrade-'));
  try {
    const file = path.join(dir, 'symbiote.json');
    fs.writeFileSync(file, JSON.stringify(legacy(dir)));
    const first = upgradeConfigFile(file, path.join(dir, '.env'));
    assert.equal(first.changed, true);
    assert.ok(first.backupPath && fs.existsSync(first.backupPath));
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf-8'), /OPENROUTER_API_KEY=sk-or-inline-secret-value/);
    assert.equal(upgradeConfigFile(file, path.join(dir, '.env')).changed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the template passes validation and the env file keeps unknown keys', () => {
  const template = buildConfigTemplate({ ownerIds: ['1'] });
  const errors = validateConfig({ ...template, workspace: process.cwd() } as any).filter(i => i.severity === 'error');
  assert.deepEqual(errors, []);

  const input = defaultSetupInput(undefined, path.join(os.tmpdir(), 'no-such.env'));
  const env = buildEnvFile(input, { CUSTOM_THING: 'keep-me', SYMBIOTE_API_KEY: 'k'.repeat(64) });
  assert.match(env, /CUSTOM_THING=keep-me/);
  assert.match(env, /SYMBIOTE_API_KEY=k{64}/);
});
