import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import { scaffoldAgent } from './agent-scaffold.js';
import { loadConfig, type SymbioteConfig } from '../config/config.js';
import { validateAndReport } from '../config/validator.js';
import { APP_VERSION, RELEASE_CODENAME } from '../meta/version.js';

export interface ProviderChoice {
  id: string;
  name: string;
  defaultModel: string;
  envKey?: string;
  needsKey?: boolean;
}

export const PROVIDERS: ProviderChoice[] = [
  { id: 'github-copilot', name: 'GitHub Copilot', defaultModel: 'claude-sonnet-4' },
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-4-20250514', envKey: 'ANTHROPIC_API_KEY', needsKey: true },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o', envKey: 'OPENAI_API_KEY', needsKey: true },
  { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-2.5-pro-preview-06-05', envKey: 'GEMINI_API_KEY', needsKey: true },
  { id: 'groq', name: 'Groq', defaultModel: 'llama-3.3-70b-versatile', envKey: 'GROQ_API_KEY', needsKey: true },
  { id: 'xai', name: 'xAI', defaultModel: 'grok-3-fast', envKey: 'XAI_API_KEY', needsKey: true },
  { id: 'nvidia', name: 'NVIDIA NIM', defaultModel: 'meta/llama-3.1-70b-instruct', envKey: 'NVIDIA_API_KEY', needsKey: true },
  { id: 'ollama', name: 'Ollama', defaultModel: 'qwen3:4b' },
  { id: 'gladius', name: 'GLADIUS', defaultModel: 'gladius-125m' },
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
}

function readEnvFile(envPath = path.resolve('.env')): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    result[key] = value;
  }
  return result;
}

export function defaultSetupInput(existing?: SymbioteConfig, envPath = path.resolve('.env')): SetupInput {
  const env = readEnvFile(envPath);
  const provider = existing?.defaultProvider ?? 'github-copilot';
  const providerChoice = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0];
  const workspace = path.resolve(existing?.workspace ?? process.cwd());
  return {
    provider,
    model: existing?.defaultModel ?? providerChoice.defaultModel,
    workspace,
    sessionsDir: existing?.sessionsDir ?? '.sessions',
    temperature: existing?.temperature ?? 0.3,
    maxTokens: existing?.maxTokens ?? 8192,
    maxIterations: existing?.maxIterations ?? 50,
    ownerIds: existing?.ownerIds ?? [],
    apiPort: existing?.apiPort ?? 3006,
    apiHost: existing?.apiHost ?? '127.0.0.1',
    webPort: existing?.webPort ?? 3009,
    webHost: existing?.webHost ?? '127.0.0.1',
    discordEnabled: !!existing?.discord?.enabled,
    discordToken: env.DISCORD_BOT_TOKEN || existing?.discord?.token,
    discordBotId: env.DISCORD_CLIENT_ID || existing?.discord?.botId,
    whatsappEnabled: !!existing?.whatsapp?.enabled,
    whatsappPhoneNumber: existing?.whatsapp?.phoneNumber,
    whatsappAuthDir: existing?.whatsapp?.authDir ?? path.join(os.homedir(), '.mach6', 'whatsapp-auth'),
    providerApiKey: providerChoice.envKey ? (process.env[providerChoice.envKey] ?? env[providerChoice.envKey]) : undefined,
    agent: {
      enabled: !fs.existsSync(path.join(workspace, 'SOUL.md')),
      name: existing?.name ?? 'Symbiote',
      emoji: existing?.emoji ?? '🤖',
      personality: 'Calm, precise, production-minded operator',
      creatorName: process.env.USER ?? process.env.USERNAME ?? 'Operator',
    },
  };
}

export function buildConfig(input: SetupInput): SymbioteConfig {
  return {
    name: input.agent.name,
    emoji: input.agent.emoji,
    defaultProvider: input.provider,
    defaultModel: input.model,
    maxTokens: input.maxTokens,
    maxIterations: input.maxIterations,
    temperature: input.temperature,
    workspace: input.workspace,
    sessionsDir: input.sessionsDir,
    ownerIds: input.ownerIds,
    apiPort: input.apiPort,
    apiHost: input.apiHost,
    webPort: input.webPort,
    webHost: input.webHost,
    allowedOrigins: [
      `http://${input.webHost}:${input.webPort}`,
      `http://127.0.0.1:${input.webPort}`,
      `http://localhost:${input.webPort}`,
    ],
    providers: {
      'github-copilot': {},
      anthropic: {},
      openai: {},
      gemini: {},
      groq: { baseUrl: 'https://api.groq.com/openai' },
      xai: {},
      nvidia: {},
      ollama: { baseUrl: 'http://127.0.0.1:11434' },
      gladius: { baseUrl: 'http://127.0.0.1:8741' },
    },
    discord: input.discordEnabled ? {
      enabled: true,
      token: '${DISCORD_BOT_TOKEN}',
      botId: input.discordBotId || '${DISCORD_CLIENT_ID}',
      policy: {
        dmPolicy: 'allowlist',
        groupPolicy: 'mention-only',
        requireMention: true,
        allowedSenders: input.ownerIds.filter(id => !id.includes('@')),
        allowedGroups: [],
        ownerIds: input.ownerIds,
      },
    } : { enabled: false },
    whatsapp: input.whatsappEnabled ? {
      enabled: true,
      authDir: input.whatsappAuthDir,
      phoneNumber: input.whatsappPhoneNumber,
      autoRead: true,
      markOnline: true,
      policy: {
        dmPolicy: 'allowlist',
        groupPolicy: 'mention-only',
        allowedSenders: input.ownerIds.filter(id => id.includes('@')),
        allowedGroups: [],
        ownerIds: input.ownerIds,
      },
    } : { enabled: false, authDir: input.whatsappAuthDir },
  };
}

export function buildEnvFile(input: SetupInput, existingEnv: Record<string, string> = {}): string {
  const selectedProvider = PROVIDERS.find(p => p.id === input.provider);
  const env = new Map<string, string>([
    ['ANTHROPIC_API_KEY', ''],
    ['OPENAI_API_KEY', ''],
    ['GEMINI_API_KEY', ''],
    ['GROQ_API_KEY', ''],
    ['XAI_API_KEY', ''],
    ['NVIDIA_API_KEY', ''],
  ]);

  for (const [key, value] of Object.entries(existingEnv)) {
    if (env.has(key) && value) env.set(key, value);
  }

  if (selectedProvider?.envKey && input.providerApiKey) {
    env.set(selectedProvider.envKey, input.providerApiKey);
  }

  const lines = [
    `# Symbiote ${APP_VERSION} — ${RELEASE_CODENAME}`,
    '# Copy to .env only if you need to adjust values manually.',
    '',
    ...Array.from(env.entries()).map(([key, value]) => `${key}=${value}`),
    '',
    `DISCORD_BOT_TOKEN=${input.discordEnabled ? (input.discordToken ?? existingEnv.DISCORD_BOT_TOKEN ?? '') : ''}`,
    `DISCORD_CLIENT_ID=${input.discordEnabled ? (input.discordBotId ?? existingEnv.DISCORD_CLIENT_ID ?? '') : ''}`,
    '',
    `MACH6_API_KEY=${existingEnv.MACH6_API_KEY || crypto.randomBytes(32).toString('hex')}`,
    `MACH6_API_PORT=${input.apiPort}`,
    `MACH6_API_HOST=${input.apiHost}`,
    `MACH6_PORT=${input.webPort}`,
    `MACH6_WEB_HOST=${input.webHost}`,
    '',
  ];

  return lines.join('\n');
}

export function writeSetupFiles(input: SetupInput, configPath = path.resolve('mach6.json'), envPath = path.resolve('.env')): SetupWriteResult {
  const existingEnv = readEnvFile(envPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.mkdirSync(input.workspace, { recursive: true });

  const config = buildConfig(input);
  if (!validateAndReport(config)) {
    throw new Error('Generated configuration failed validation');
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(envPath, buildEnvFile(input, existingEnv) + '\n');

  const createdIdentityFiles = input.agent.enabled
    ? scaffoldAgent({
        name: input.agent.name,
        emoji: input.agent.emoji,
        personality: input.agent.personality,
        creatorName: input.agent.creatorName,
        workspace: input.workspace,
      })
    : [];

  return { configPath, envPath, config, createdIdentityFiles };
}

function parseCsv(input: string): string[] {
  return input.split(',').map(s => s.trim()).filter(Boolean);
}

function choiceLabel(providerId: string): string {
  const choice = PROVIDERS.find(p => p.id === providerId);
  return choice ? `${choice.name} (${choice.id})` : providerId;
}

async function ask(rl: readline.Interface, prompt: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise(resolve => rl.question(`${prompt}${suffix}: `, answer => resolve(answer.trim() || defaultValue)));
}

async function askYesNo(rl: readline.Interface, prompt: string, defaultValue: boolean): Promise<boolean> {
  const label = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await ask(rl, `${prompt} [${label}]`, '')).toLowerCase();
  if (!answer) return defaultValue;
  return answer.startsWith('y');
}

async function askMasked(rl: readline.Interface, prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return ask(rl, prompt, '');
  }

  return new Promise(resolve => {
    process.stdout.write(`${prompt}: `);
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    const onData = (buffer: Buffer) => {
      const key = buffer.toString();
      if (key === '\r' || key === '\n') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(wasRaw ?? false);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (key === '\u0003') process.exit(1);
      if (key === '\u007f' || key === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (buffer[0] >= 32) {
        value += key;
        process.stdout.write('•');
      }
    };
    stdin.on('data', onData);
  });
}

export async function runInteractiveSetup(configPath = path.resolve('mach6.json'), envPath = path.resolve('.env')): Promise<SetupWriteResult> {
  const existing = fs.existsSync(configPath) ? loadConfig(configPath) : undefined;
  const defaults = defaultSetupInput(existing, envPath);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(`\nSymbiote ${APP_VERSION} — ${RELEASE_CODENAME} setup\n`);
    PROVIDERS.forEach((provider, index) => {
      console.log(`  ${index + 1}. ${provider.name} (${provider.id})`);
    });

    const providerAnswer = await ask(rl, 'Select provider by number or id', defaults.provider);
    const provider = PROVIDERS[Number(providerAnswer) - 1]?.id
      ?? (PROVIDERS.find(p => p.id === providerAnswer)?.id ?? defaults.provider);
    const selectedProvider = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0];

    const model = await ask(rl, 'Default model', existing?.defaultModel ?? selectedProvider.defaultModel);
    const workspace = path.resolve(await ask(rl, 'Workspace directory', defaults.workspace));
    const apiPort = parseInt(await ask(rl, 'HTTP API port', String(defaults.apiPort)), 10);
    const apiHost = await ask(rl, 'HTTP API host', defaults.apiHost);
    const webPort = parseInt(await ask(rl, 'Web UI port', String(defaults.webPort)), 10);
    const webHost = await ask(rl, 'Web UI host', defaults.webHost);
    const ownerIds = parseCsv(await ask(rl, 'Owner IDs (comma separated)', defaults.ownerIds.join(', ')));

    const discordEnabled = await askYesNo(rl, 'Enable Discord', defaults.discordEnabled);
    const discordToken = discordEnabled
      ? await askMasked(rl, 'Discord bot token') || defaults.discordToken || ''
      : '';
    const discordBotId = discordEnabled
      ? await ask(rl, 'Discord application/client ID', defaults.discordBotId ?? '')
      : '';

    const whatsappEnabled = await askYesNo(rl, 'Enable WhatsApp', defaults.whatsappEnabled);
    const whatsappPhoneNumber = whatsappEnabled
      ? await ask(rl, 'WhatsApp phone number (country code, digits only)', defaults.whatsappPhoneNumber ?? '')
      : '';
    const whatsappAuthDir = path.resolve(await ask(rl, 'WhatsApp auth directory', defaults.whatsappAuthDir));

    const createIdentity = await askYesNo(rl, 'Create workspace identity files', defaults.agent.enabled);
    const agentName = createIdentity ? await ask(rl, 'Agent name', defaults.agent.name) : defaults.agent.name;
    const agentEmoji = createIdentity ? await ask(rl, 'Agent emoji', defaults.agent.emoji) : defaults.agent.emoji;
    const creatorName = createIdentity ? await ask(rl, 'Creator/operator name', defaults.agent.creatorName) : defaults.agent.creatorName;
    const personality = createIdentity ? await ask(rl, 'Agent personality', defaults.agent.personality) : defaults.agent.personality;

    const providerApiKey = selectedProvider.needsKey
      ? await askMasked(rl, `${choiceLabel(provider)} API key`) || defaults.providerApiKey || ''
      : defaults.providerApiKey;

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
      whatsappAuthDir,
      agent: {
        enabled: createIdentity,
        name: agentName,
        emoji: agentEmoji,
        personality,
        creatorName,
      },
    }, configPath, envPath);

    console.log(`\nSaved ${result.configPath}`);
    console.log(`Saved ${result.envPath}`);
    if (result.createdIdentityFiles.length > 0) {
      console.log(`Created workspace files: ${result.createdIdentityFiles.join(', ')}`);
    }
    console.log();
    return result;
  } finally {
    rl.close();
  }
}
