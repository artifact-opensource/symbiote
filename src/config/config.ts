// Mach6 — Config loading

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

export interface Mach6Config {
  providers: {
    anthropic?: { apiKey?: string; baseUrl?: string; timeoutMs?: number };
    // openai provider exists as protocol layer (used by Copilot/Gladius) but not as direct config
    'github-copilot'?: { baseUrl?: string; timeoutMs?: number };
    gladius?: { baseUrl?: string; timeoutMs?: number };
    groq?: { apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number };
    ollama?: { baseUrl?: string; model?: string; timeoutMs?: number; contextWindow?: number };
    [key: string]: Record<string, unknown> | undefined;
  };
  defaultProvider: string;
  defaultModel: string;
  /** Ordered fallback provider chain — tried in sequence if primary fails */
  fallbackProviders?: string[];
  maxTokens: number;
  temperature: number;
  maxIterations?: number;
  workspace: string;
  workspaceRoots?: string[];
  sessionsDir?: string;
  heartbeat?: HeartbeatConfigBlock;
  timeouts?: Record<string, number>;
  channels?: Record<string, ChannelConfig>;
  budgets?: Record<string, BudgetConfig>;
  orchestrator?: any;
  adaptiveTemperature?: {
    adaptive?: boolean;
    profile?: Partial<Record<string, number>>;
    default?: number;
    logChanges?: boolean;
  };
}

const DEFAULT_CONFIG: Mach6Config = {
  providers: {},
  defaultProvider: 'github-copilot',
  defaultModel: 'claude-sonnet-4',
  maxTokens: 8192,
  temperature: 0.7,
  maxIterations: 50,
  workspace: process.cwd(),
};

/**
 * Recursively resolve ${ENV_VAR} references in string values.
 */
function resolveEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) result[k] = resolveEnvVars(v);
    return result;
  }
  return obj;
}

function resolveEnvKeys(config: Mach6Config): Mach6Config {
  // Resolve ${VAR} patterns throughout config
  config = resolveEnvVars(config);

  // Inject API keys from environment if not in config
  if (!config.providers.anthropic?.apiKey && process.env.ANTHROPIC_API_KEY) {
    config.providers.anthropic = { ...config.providers.anthropic, apiKey: process.env.ANTHROPIC_API_KEY };
  }
  // OpenAI direct API removed — we route through GitHub Copilot
  return config;
}

function pickWorkspace(workspace: unknown, fallback: string): { workspace: string; workspaceRoots?: string[] } {
  if (typeof workspace === 'string' && workspace.trim()) {
    return { workspace };
  }

  if (Array.isArray(workspace)) {
    const workspaceRoots = workspace.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const preferred =
      workspaceRoots.find((candidate) => fs.existsSync(path.join(candidate, 'SOUL.md')) || fs.existsSync(path.join(candidate, 'IDENTITY.md')))
      ?? workspaceRoots.find((candidate) => fs.existsSync(candidate))
      ?? fallback;

    return {
      workspace: preferred,
      workspaceRoots: workspaceRoots.length > 0 ? workspaceRoots : undefined,
    };
  }

  return { workspace: fallback };
}

export function loadConfig(configPath?: string): Mach6Config {
  const tryPaths = configPath
    ? [configPath]
    : [
        path.join(process.cwd(), 'mach6.json'),
        path.join(os.homedir(), '.mach6', 'config.json'),
      ];

  for (const p of tryPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      // Strip comments but preserve // inside strings (e.g. "http://...")
      // Strategy: match strings first (preserve), then strip line/block comments
      const stripped = raw.replace(
        /"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm,
        (match) => match.startsWith('"') ? match : ''
      );
      const parsed = JSON.parse(stripped);
      const normalizedWorkspace = pickWorkspace(parsed.workspace, DEFAULT_CONFIG.workspace);
      return resolveEnvKeys({
        ...DEFAULT_CONFIG,
        ...parsed,
        ...normalizedWorkspace,
      });
    } catch { continue; }
  }

  return resolveEnvKeys({ ...DEFAULT_CONFIG });
}

// Re-export for validator
export type { Mach6Config as Mach6ConfigType };

/**
 * Convert the mach6.json `adaptiveTemperature` (or top-level `temperature` object) block
 * into a TemperatureConfig for the ATM system.
 */
export function toTemperatureConfig(config: Mach6Config): TemperatureConfig {
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
