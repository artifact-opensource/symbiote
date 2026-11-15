import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeConfig, upgradeConfigFile } from '../config/upgrade.js';
import { loadConfig } from '../config/config.js';
import { buildConfigTemplate, CONFIG_VERSION } from '../config/template.js';
import { validateConfig } from '../config/validator.js';
import { buildConfig, buildEnvFile, defaultSetupInput } from '../cli/setup.js';

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
  for (const key of ['heartbeat', 'timeouts', 'tools', 'whatsapp', 'orchestrator', 'adaptiveTemperature', 'memory']) assert.ok(key in config, key);
  assert.equal(config.memory.neural.model, buildConfigTemplate({}).memory.neural.model);
  assert.equal(config.memory.neural.enabled, false);
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

test('Cloudflare is available in setup with account ID and token environment references', () => {
  const input = {
    ...defaultSetupInput(undefined, path.join(os.tmpdir(), 'no-such.env')),
    provider: 'cloudflare',
    model: '@cf/openai/gpt-oss-20b',
    providerApiKey: 'cloudflare-test-token',
    providerAccountId: '0123456789abcdef0123456789abcdef',
  };
  const config = buildConfig(input);
  const env = buildEnvFile(input);

  assert.deepEqual(config.sarsiProviders, ['cloudflare']);
  assert.equal(config.providers.cloudflare.model, input.model);
  assert.equal(config.providers.cloudflare.apiKey, '${CLOUDFLARE_API_TOKEN}');
  assert.equal(config.providers.cloudflare.accountId, '${CLOUDFLARE_ACCOUNT_ID}');
  assert.match(env, /CLOUDFLARE_API_TOKEN=cloudflare-test-token/);
  assert.match(env, /CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef/);
});

test('config fallback does not choose a model outside symbiote.json', () => {
  const missingConfig = path.join(os.tmpdir(), `symbiote-missing-${process.pid}.json`);
  assert.equal(loadConfig(missingConfig).defaultModel, '');
});

test('config loading reports errors for existing invalid files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-invalid-config-'));
  const configPath = path.join(dir, 'symbiote.json');
  try {
    fs.writeFileSync(configPath, '{');
    assert.throws(() => loadConfig(configPath), /Failed to load configuration.*symbiote\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FreeAI key is loaded from the environment when its config key is unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-freeai-config-'));
  const previousKey = process.env.FREEAI_API_KEY;
  try {
    process.env.FREEAI_API_KEY = 'test-freeai-key';
    const configPath = path.join(dir, 'symbiote.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: { freeai: { baseUrl: 'https://freeai-test.example/v1' } },
    }));

    const config = loadConfig(configPath);
    assert.equal(config.providers.freeai?.apiKey, 'test-freeai-key');
  } finally {
    if (previousKey === undefined) delete process.env.FREEAI_API_KEY;
    else process.env.FREEAI_API_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat intervals and quiet-hour boundaries reject invalid values', () => {
  const template = buildConfigTemplate({ ownerIds: ['1'] });
  const config = { ...template, workspace: process.cwd(), heartbeat: {
    activeIntervalMin: 0,
    idleIntervalMin: 1.5,
    sleepingIntervalMin: Number.POSITIVE_INFINITY,
    quietHoursStart: 24,
    quietHoursEnd: -1,
  } };
  const issues = validateConfig(config as any).filter(issue => issue.field.startsWith('heartbeat.'));
  assert.deepEqual(issues.map(issue => issue.field).sort(), [
    'heartbeat.activeIntervalMin',
    'heartbeat.idleIntervalMin',
    'heartbeat.quietHoursEnd',
    'heartbeat.quietHoursStart',
    'heartbeat.sleepingIntervalMin',
  ]);
});

test('neural memory settings require an installed model and valid hybrid weights', () => {
  const template = buildConfigTemplate({ ownerIds: ['1'] });
  const config = {
    ...template,
    workspace: process.cwd(),
    memory: { neural: { enabled: true, model: ' ', lexicalWeight: 0, denseWeight: 0 } },
  };
  const issues = validateConfig(config as any).filter(issue => issue.field.startsWith('memory.neural'));
  assert.deepEqual(issues.map(issue => issue.field).sort(), ['memory.neural', 'memory.neural.model']);
});
