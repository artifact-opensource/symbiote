// Symbiote — Config loading

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TemperatureConfig, TaskCategory } from '../agent/temperature.js';

export interface ChannelConfig {
  accountKey?: string;
  countryCode?: string;
  [key: string]: unknown;
}

export interface BudgetConfig {
  dailyLimit?: number;
  perRun?: number;
}

export interface HeartbeatConfigBlock {
  activeIntervalMin?: number;
  idleIntervalMin?: number;
  sleepingIntervalMin?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
}

export interface ChannelPolicyConfig {
  dmPolicy?: string;
  groupPolicy?: string;
  requireMention?: boolean;
  allowedSenders?: string[];
  allowedGroups?: string[];
  ownerIds?: string[];
  selfId?: string;
  selfIdAliases?: string[];
}

export interface DiscordConfigBlock {
  enabled?: boolean;
  token?: string;
  botId?: string;
  adapterId?: string;
  siblingBotIds?: string[];
  policy?: ChannelPolicyConfig;
  promptFiles?: { path: string; label: string }[];
}

export interface WhatsAppConfigBlock {
  enabled?: boolean;
  authDir?: string;
  phoneNumber?: string;
  autoRead?: boolean;
  markOnline?: boolean;
  policy?: ChannelPolicyConfig;
}

export interface ProviderConfigBlock {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  contextWindow?: number;
  [key: string]: unknown;
}

export interface SymbioteConfig {
  name?: string;
  emoji?: string;
  providers: Record<string, ProviderConfigBlock | undefined> & {
    anthropic?: ProviderConfigBlock;
    openai?: ProviderConfigBlock;
    gemini?: ProviderConfigBlock;
    groq?: ProviderConfigBlock;
    xai?: ProviderConfigBlock;
    nvidia?: ProviderConfigBlock;
    ollama?: ProviderConfigBlock;
    gladius?: ProviderConfigBlock;
    'github-copilot'?: ProviderConfigBlock;
  };
  defaultProvider: string;
  defaultModel: string;
  fallbackProviders?: string[];
  maxTokens: number;
  temperature: number;
  maxIterations?: number;
  workspace: string;
  sessionsDir?: string;
  ownerIds?: string[];
  apiPort?: number;
  apiHost?: string;
  webPort?: number;
  webHost?: string;
  allowedOrigins?: string[];
  heartbeat?: HeartbeatConfigBlock;
  timeouts?: Record<string, number>;
  channels?: Record<string, ChannelConfig>;
  budgets?: Record<string, BudgetConfig>;
  adaptiveTemperature?: {
    adaptive?: boolean;
    profile?: Partial<Record<string, number>>;
    default?: number;
    logChanges?: boolean;
  };
  discord?: DiscordConfigBlock;
  discordExtra?: DiscordConfigBlock[];
  whatsapp?: WhatsAppConfigBlock;
  tools?: {
    enabled?: boolean;
  };
}

const DEFAULT_CONFIG: SymbioteConfig = {
  providers: {},
  defaultProvider: 'github-copilot',
  defaultModel: 'claude-sonnet-4',
  maxTokens: 8192,
  temperature: 0.7,
  maxIterations: 50,
  workspace: process.cwd(),
  ownerIds: [],
  apiPort: 3006,
  apiHost: '127.0.0.1',
  webPort: 3009,
  webHost: '127.0.0.1',
  allowedOrigins: [
    'http://127.0.0.1:3009',
    'http://localhost:3009',
  ],
};

function stripJsonComments(raw: string): string {
  return raw.replace(
    /"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm,
    (match) => match.startsWith('"') ? match : ''
  );
}

/**
 * Recursively resolve ${ENV_VAR} references in string values.
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = resolveEnvVars(v);
    return result;
  }
  return obj;
}

function resolveEnvKeys(config: SymbioteConfig): SymbioteConfig {
  config = resolveEnvVars(config) as SymbioteConfig;

  const injectKey = (provider: keyof SymbioteConfig['providers'], envKey: string): void => {
    const value = process.env[envKey];
    if (!value) return;
    if (!config.providers[provider]?.apiKey) {
      config.providers[provider] = { ...(config.providers[provider] ?? {}), apiKey: value };
    }
  };

  injectKey('anthropic', 'ANTHROPIC_API_KEY');
  injectKey('openai', 'OPENAI_API_KEY');
  injectKey('gemini', 'GEMINI_API_KEY');
  injectKey('groq', 'GROQ_API_KEY');
  injectKey('xai', 'XAI_API_KEY');
  injectKey('nvidia', 'NVIDIA_API_KEY');

  if (!config.discord?.token && process.env.DISCORD_BOT_TOKEN) {
    config.discord = { ...(config.discord ?? {}), token: process.env.DISCORD_BOT_TOKEN };
  }

  if (process.env.MACH6_API_PORT && !config.apiPort) {
    config.apiPort = Number(process.env.MACH6_API_PORT);
  }
  if (process.env.MACH6_PORT && !config.webPort) {
    config.webPort = Number(process.env.MACH6_PORT);
  }
  if (process.env.MACH6_API_HOST && !config.apiHost) {
    config.apiHost = process.env.MACH6_API_HOST;
  }
  if (process.env.MACH6_WEB_HOST && !config.webHost) {
    config.webHost = process.env.MACH6_WEB_HOST;
  }

  return config;
}

export function loadConfig(configPath?: string): SymbioteConfig {
  const tryPaths = configPath
    ? [configPath]
    : [
        path.join(process.cwd(), 'mach6.json'),
        path.join(os.homedir(), '.mach6', 'config.json'),
      ];

  for (const p of tryPaths) {
    try {
      let raw = fs.readFileSync(p, 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const parsed = JSON.parse(stripJsonComments(raw)) as Partial<SymbioteConfig>;
      return resolveEnvKeys({ ...DEFAULT_CONFIG, ...parsed, providers: { ...DEFAULT_CONFIG.providers, ...(parsed.providers ?? {}) } });
    } catch {
      continue;
    }
  }

  return resolveEnvKeys({ ...DEFAULT_CONFIG });
}

export type { SymbioteConfig as SymbioteConfigType };

export function toTemperatureConfig(config: SymbioteConfig): TemperatureConfig {
  const atm = config.adaptiveTemperature;
  if (!atm || !atm.adaptive) {
    return {
      enabled: false,
      defaultTemp: config.temperature,
    };
  }

  return {
    enabled: true,
    profile: atm.profile as Partial<Record<TaskCategory, number>> | undefined,
    defaultTemp: atm.default ?? config.temperature,
    logChanges: atm.logChanges ?? false,
  };
}
