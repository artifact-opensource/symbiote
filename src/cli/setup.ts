import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { scaffoldAgent } from './agent-scaffold.js';
import { loadConfig, type SymbioteConfig } from '../config/config.js';
import { validateConfig } from '../config/validator.js';
import { APP_VERSION, RELEASE_CODENAME } from '../meta/version.js';
import { CONFIG_VERSION, PROVIDER_ENV, SCHEMA_REF, buildConfigTemplate } from '../config/template.js';
import { ensureSchema, readConfigFile, readEnv, upgradeConfig } from '../config/upgrade.js';
import { box, cmd, heading, hint, kv, palette, versionBanner } from './brand.js';
import { Prompter, type Option } from './ui.js';

export interface ProviderChoice {
  id: string;
  name: string;
  defaultModel: string;
  envKey?: string;
  needsKey?: boolean;
  note?: string;
}

export const PROVIDERS: ProviderChoice[] = [
  { id: 'openrouter', name: 'OpenRouter', defaultModel: 'openrouter/free', envKey: PROVIDER_ENV.openrouter, needsKey: true, note: 'one key, many models' },
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-4-20250514', envKey: PROVIDER_ENV.anthropic, needsKey: true },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o', envKey: PROVIDER_ENV.openai, needsKey: true },
  { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-2.5-pro', envKey: PROVIDER_ENV.gemini, needsKey: true },
  { id: 'groq', name: 'Groq', defaultModel: 'llama-3.3-70b-versatile', envKey: PROVIDER_ENV.groq, needsKey: true, note: 'fast inference' },
  { id: 'xai', name: 'xAI', defaultModel: 'grok-3-fast', envKey: PROVIDER_ENV.xai, needsKey: true },
  { id: 'nvidia', name: 'NVIDIA NIM', defaultModel: 'meta/llama-3.1-70b-instruct', envKey: PROVIDER_ENV.nvidia, needsKey: true },
  { id: 'github-copilot', name: 'GitHub Copilot', defaultModel: 'claude-sonnet-4', note: 'uses your gh login' },
  { id: 'ollama', name: 'Ollama', defaultModel: 'qwen3:4b', note: 'local' },
  { id: 'gladius', name: 'GLADIUS', defaultModel: 'gladius-125m', note: 'local' },
];

export interface AgentIdentityInput {
  enabled: boolean;
  name: string;
  emoji: string;
  personality: string;
  creatorName: string;
}

export interface SetupInput {
  provider: string;
  model: string;
  providerApiKey?: string;
  workspace: string;
  sessionsDir: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  ownerIds: string[];
  apiPort: number;
  apiHost: string;
  webPort: number;
  webHost: string;
  discordEnabled: boolean;
  discordToken?: string;
  discordBotId?: string;
  whatsappEnabled: boolean;
  whatsappPhoneNumber?: string;
  whatsappAuthDir: string;
  agent: AgentIdentityInput;
}

export interface SetupWriteResult {
  configPath: string;
  envPath: string;
  config: SymbioteConfig;
  createdIdentityFiles: string[];
  warnings: string[];
  backupPath?: string;
}

/** Wizard-controlled fields. Everything else in an existing config is preserved on re-run. */
const WIZARD_KEYS = ['name', 'emoji', 'defaultProvider', 'defaultModel', 'temperature', 'maxTokens', 'maxIterations',
  'workspace', 'ownerIds', 'apiHost', 'apiPort', 'webHost', 'webPort', 'allowedOrigins'] as const;

export function defaultSetupInput(existing?: SymbioteConfig, envPath = path.resolve('.env')): SetupInput {
  const env = readEnv(envPath);
  const provider = existing?.defaultProvider ?? 'openrouter';
  const choice = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0];
  const workspace = path.resolve(existing?.workspace ?? process.cwd());
  const template = buildConfigTemplate();
  return {
    provider,
    model: existing?.defaultModel ?? choice.defaultModel,
    workspace,
    sessionsDir: existing?.sessionsDir ?? template.sessionsDir,
    temperature: existing?.temperature ?? template.temperature,
    maxTokens: existing?.maxTokens ?? template.maxTokens,
    maxIterations: existing?.maxIterations ?? template.maxIterations,
    ownerIds: existing?.ownerIds ?? [],
    apiPort: existing?.apiPort ?? template.apiPort,
    apiHost: existing?.apiHost ?? template.apiHost,
    webPort: existing?.webPort ?? template.webPort,
    webHost: existing?.webHost ?? template.webHost,
    discordEnabled: !!existing?.discord?.enabled,
    discordToken: env.DISCORD_BOT_TOKEN || undefined,
    discordBotId: env.DISCORD_CLIENT_ID || (existing?.discord?.botId && !existing.discord.botId.startsWith('${') ? existing.discord.botId : undefined),
    whatsappEnabled: !!existing?.whatsapp?.enabled,
    whatsappPhoneNumber: existing?.whatsapp?.phoneNumber,
    whatsappAuthDir: existing?.whatsapp?.authDir ?? template.whatsapp.authDir,
    providerApiKey: choice.envKey ? (process.env[choice.envKey] ?? env[choice.envKey]) : undefined,
    agent: {
      enabled: !fs.existsSync(path.join(workspace, 'SOUL.md')),
      name: existing?.name ?? 'Symbiote',
      emoji: existing?.emoji ?? '🤖',
      personality: 'Calm, precise, production-minded operator',
      creatorName: process.env.USERNAME ?? process.env.USER ?? 'Operator',
    },
  };
}

/** Build the complete config for a setup run. Paths are written relative to the config file. */
export function buildConfig(input: SetupInput, configDir = process.cwd()): Record<string, any> {
  const rel = path.relative(configDir, input.workspace).replace(/\\/g, '/');
  const config = buildConfigTemplate({
    name: input.agent.name,
    emoji: input.agent.emoji,
    provider: input.provider,
    model: input.model,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    maxIterations: input.maxIterations,
    ownerIds: input.ownerIds,
    apiHost: input.apiHost,
    apiPort: input.apiPort,
    webHost: input.webHost,
    webPort: input.webPort,
    discord: { enabled: input.discordEnabled, botId: input.discordBotId },
    whatsapp: { enabled: input.whatsappEnabled, phoneNumber: input.whatsappPhoneNumber || undefined, authDir: toPortablePath(input.whatsappAuthDir) },
  });
  config.workspace = rel === '' ? '.' : rel.startsWith('..') && path.isAbsolute(input.workspace) ? input.workspace : rel;
  config.sessionsDir = input.sessionsDir;
  return config;
}

/** Store paths under the home directory as ~/..., so the file is portable across machines. */
function toPortablePath(p: string): string {
  if (p.startsWith('~')) return p;
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return p;
  const rel = path.relative(home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
}

const ENV_SECTIONS: Array<{ title: string; keys: string[] }> = [
  { title: 'LLM provider keys', keys: Object.values(PROVIDER_ENV) },
  { title: 'Discord', keys: ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID'] },
  { title: 'HTTP API', keys: ['SYMBIOTE_API_KEY', 'SYMBIOTE_API_PORT', 'SYMBIOTE_API_HOST', 'SYMBIOTE_PORT', 'SYMBIOTE_WEB_HOST'] },
];

export function buildEnvFile(input: SetupInput, existingEnv: Record<string, string> = {}): string {
  const selected = PROVIDERS.find(p => p.id === input.provider);
  const values: Record<string, string> = { ...existingEnv };

  if (selected?.envKey && input.providerApiKey) values[selected.envKey] = input.providerApiKey;
  if (input.discordEnabled) {
    if (input.discordToken) values.DISCORD_BOT_TOKEN = input.discordToken;
    if (input.discordBotId) values.DISCORD_CLIENT_ID = input.discordBotId;
  }
  values.SYMBIOTE_API_KEY ||= crypto.randomBytes(32).toString('hex');
  values.SYMBIOTE_API_PORT = String(input.apiPort);
  values.SYMBIOTE_API_HOST = input.apiHost;
  values.SYMBIOTE_PORT = String(input.webPort);
  values.SYMBIOTE_WEB_HOST = input.webHost;

  const known = new Set(ENV_SECTIONS.flatMap(s => s.keys));
  const lines = [`# Symbiote ${APP_VERSION} ${RELEASE_CODENAME} — secrets and runtime overrides. Never commit this file.`];
  for (const section of ENV_SECTIONS) {
    lines.push('', `# ${section.title}`, ...section.keys.map(key => `${key}=${values[key] ?? ''}`));
  }
  const custom = Object.keys(values).filter(key => !known.has(key));
  if (custom.length) lines.push('', '# Custom', ...custom.map(key => `${key}=${values[key]}`));
  return lines.join('\n') + '\n';
}

function timestamp(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
}

export function writeSetupFiles(input: SetupInput, configPath = path.resolve('symbiote.json'), envPath = path.resolve('.env')): SetupWriteResult {
  const configDir = path.dirname(path.resolve(configPath));
  const existingEnv = readEnv(envPath);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.mkdirSync(input.workspace, { recursive: true });

  let config = buildConfig(input, configDir);
  let backupPath: string | undefined;

  if (fs.existsSync(configPath)) {
    // Re-running setup: upgrade the old file, then overlay only what the wizard asked about.
    try {
      const upgraded = upgradeConfig(readConfigFile(configPath), { configDir, existingEnv }).config;
      const overlay: Record<string, any> = {};
      for (const key of WIZARD_KEYS) overlay[key] = config[key];
      overlay.discord = { ...upgraded.discord, enabled: config.discord.enabled, botId: config.discord.botId, policy: { ...upgraded.discord?.policy, ownerIds: config.ownerIds } };
      overlay.whatsapp = { ...upgraded.whatsapp, ...config.whatsapp };
      config = { ...upgraded, ...overlay };
    } catch {
      // Unreadable existing file: the backup below preserves it and the fresh config replaces it.
    }
    backupPath = `${configPath}.bak-${timestamp()}`;
    fs.copyFileSync(configPath, backupPath);
  }

  config.$schema = SCHEMA_REF;
  config.configVersion = CONFIG_VERSION;

  const resolved = { ...config, workspace: input.workspace, sessionsDir: path.resolve(configDir, config.sessionsDir ?? '.sessions') } as unknown as SymbioteConfig;
  const issues = validateConfig(resolved);
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length) throw new Error(`Generated configuration failed validation: ${errors.map(e => `${e.field}: ${e.message}`).join('; ')}`);

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(envPath, buildEnvFile(input, existingEnv));
  try { fs.chmodSync(envPath, 0o600); } catch { /* not supported on this filesystem */ }
  ensureSchema(configDir);

  const createdIdentityFiles = input.agent.enabled
    ? scaffoldAgent({
        name: input.agent.name,
        emoji: input.agent.emoji,
        personality: input.agent.personality,
        creatorName: input.agent.creatorName,
        workspace: input.workspace,
      })
    : [];

  return {
    configPath,
    envPath,
    config: resolved,
    createdIdentityFiles,
    warnings: issues.filter(i => i.severity === 'warning').map(i => `${i.field}: ${i.message}`),
    backupPath,
  };
}

const parseCsv = (value: string): string[] => value.split(',').map(s => s.trim()).filter(Boolean);

export async function runInteractiveSetup(configPath = path.resolve('symbiote.json'), envPath = path.resolve('.env')): Promise<SetupWriteResult> {
  const existing = fs.existsSync(configPath) ? loadConfig(configPath) : undefined;
  const defaults = defaultSetupInput(existing, envPath);
  const ask = new Prompter();

  try {
    console.log(versionBanner(APP_VERSION));
    console.log(hint(existing ? 'Reconfiguring. Press Enter to keep the current value.' : 'First-time setup. Press Enter to accept the default shown in brackets.'));

    // ── Model
    ask.section('Model');
    const options: Option[] = PROVIDERS.map(p => ({ id: p.id, label: p.name, note: p.note }));
    const provider = await ask.choose('Provider', options, defaults.provider);
    const choice = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0];
    const model = await ask.text('Model', provider === defaults.provider ? defaults.model : choice.defaultModel);
    const providerApiKey = choice.needsKey ? await ask.secret(`${choice.name} API key`, defaults.providerApiKey) : undefined;

    // ── Workspace
    ask.section('Workspace');
    const workspace = path.resolve(await ask.text('Directory', defaults.workspace));
    const ownerIds = parseCsv(await ask.text('Owner IDs (comma separated, optional)', defaults.ownerIds.join(', ')));

    // ── Channels
    ask.section('Channels');
    const discordEnabled = await ask.confirm('Discord', defaults.discordEnabled);
    const discordToken = discordEnabled ? await ask.secret('  Bot token', defaults.discordToken) : undefined;
    const discordBotId = discordEnabled ? await ask.text('  Application ID', defaults.discordBotId ?? '') : undefined;
    const whatsappEnabled = await ask.confirm('WhatsApp', defaults.whatsappEnabled);
    const whatsappPhoneNumber = whatsappEnabled ? await ask.text('  Phone (digits, with country code)', defaults.whatsappPhoneNumber ?? '') : undefined;

    // ── Identity
    ask.section('Identity');
    const identity = await ask.confirm('Create workspace identity files', defaults.agent.enabled);
    const agentName = await ask.text('Agent name', defaults.agent.name);
    const creatorName = identity ? await ask.text('Operator name', defaults.agent.creatorName) : defaults.agent.creatorName;

    // ── Network (advanced)
    let { apiHost, apiPort, webHost, webPort } = defaults;
    if (await ask.confirm('Customize network settings', false)) {
      ask.section('Network');
      apiHost = await ask.text('API host', apiHost);
      apiPort = await ask.number('API port', apiPort, 1, 65535);
      webHost = await ask.text('Web UI host', webHost);
      webPort = await ask.number('Web UI port', webPort, 1, 65535);
    }

    const result = writeSetupFiles({
      provider,
      model,
      providerApiKey,
      workspace,
      sessionsDir: defaults.sessionsDir,
      temperature: defaults.temperature,
      maxTokens: defaults.maxTokens,
      maxIterations: defaults.maxIterations,
      ownerIds,
      apiPort,
      apiHost,
      webPort,
      webHost,
      discordEnabled,
      discordToken,
      discordBotId,
      whatsappEnabled,
      whatsappPhoneNumber,
      whatsappAuthDir: defaults.whatsappAuthDir,
      agent: { ...defaults.agent, enabled: identity, name: agentName, creatorName },
    }, configPath, envPath);

    printSetupSummary(result, choice.name);
    return result;
  } finally {
    ask.close();
  }
}

export function printSetupSummary(result: SetupWriteResult, providerName: string): void {
  const cfg = result.config;
  const channels = [cfg.discord?.enabled && 'Discord', cfg.whatsapp?.enabled && 'WhatsApp'].filter(Boolean).join(' · ') || 'none';
  console.log();
  console.log(box([
    `${palette.green}✓${palette.reset} ${palette.bold}Setup complete${palette.reset}`,
    '',
    kv('Config', `${palette.white}${path.basename(result.configPath)}${palette.reset}`, 10),
    kv('Secrets', `${palette.white}${path.basename(result.envPath)}${palette.reset} ${palette.dim}(private)${palette.reset}`, 10),
    kv('Model', `${palette.cyan}${providerName}${palette.reset}${palette.dim} / ${palette.reset}${palette.white}${cfg.defaultModel}${palette.reset}`, 10),
    kv('Channels', `${palette.white}${channels}${palette.reset}`, 10),
    ...(result.createdIdentityFiles.length ? [kv('Identity', `${palette.white}${result.createdIdentityFiles.length} files${palette.reset}`, 10)] : []),
  ], { borderColor: palette.violet }));
  for (const w of result.warnings) console.log(hint(`note: ${w}`));
  if (result.backupPath) console.log(hint(`previous config saved as ${path.basename(result.backupPath)}`));
  console.log();
  console.log(`  ${palette.dim}Next${palette.reset}  ${cmd('symbiote start')} ${palette.dim}to launch the daemon, or${palette.reset} ${cmd('symbiote')} ${palette.dim}for the interactive agent${palette.reset}`);
  console.log();
}

export { heading };
