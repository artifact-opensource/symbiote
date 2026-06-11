// Symbiote — GitHub Copilot proxy provider
// Uses the copilot token exchange flow: GitHub PAT → copilot session token → OpenAI-compat API

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { openaiProvider } from './openai.js';

/** Resolve the user home directory cross-platform */
function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? (process.platform === 'win32' ? 'C:\\Users\\default' : '/tmp');
}

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_BASE_URL = 'https://api.individual.githubcopilot.com';

interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
  updatedAt: number;
}

let cachedToken: CachedToken | null = null;

function tokenCachePath(): string {
  return path.join(homeDir(), '.symbiote', 'credentials', 'github-copilot.token.json');
}

function loadCachedToken(): CachedToken | null {
  try {
    const data = JSON.parse(fs.readFileSync(tokenCachePath(), 'utf-8'));
    if (data?.token && data?.expiresAt) return data as CachedToken;
  } catch { /* ignore */ }
  return null;
}

function saveCachedToken(t: CachedToken): void {
  try {
    const p = tokenCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
  } catch { /* best effort */ }
}

function isUsable(t: CachedToken): boolean {
  return t.expiresAt - Date.now() > 5 * 60 * 1000; // 5 min margin
}

function deriveBaseUrl(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const ep = match?.[1]?.trim();
  if (!ep) return DEFAULT_BASE_URL;
  const host = ep.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.');
  return `https://${host}`;
}

async function resolveGitHubToken(): Promise<string> {
  const home = homeDir();

  // Copilot-specific env var takes highest priority
  const copilotEnv = process.env.COPILOT_GITHUB_TOKEN;
  if (copilotEnv?.trim()) return copilotEnv.trim();

  // Copilot CLI token (ghu_ tokens work with copilot_internal endpoint)
  const copilotCliPath = path.join(home, '.copilot-cli-access-token');
  try {
    const cliToken = fs.readFileSync(copilotCliPath, 'utf-8').trim();
    if (cliToken) return cliToken;
  } catch { /* not found */ }

  // Fall back to general GitHub tokens from environment
  const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  // Try hosts.json (Unix/macOS path)
  const hostsPath = path.join(home, '.config', 'github-copilot', 'hosts.json');
  try {
    const hosts = JSON.parse(fs.readFileSync(hostsPath, 'utf-8'));
    for (const key of Object.keys(hosts)) {
      if (hosts[key]?.oauth_token) return hosts[key].oauth_token;
    }
  } catch { /* not found */ }

  // Windows: VS Code Copilot extension stores token in AppData
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const winHostsPath = path.join(appData, 'github-copilot', 'hosts.json');
    try {
      const hosts = JSON.parse(fs.readFileSync(winHostsPath, 'utf-8'));
      for (const key of Object.keys(hosts)) {
        if (hosts[key]?.oauth_token) return hosts[key].oauth_token;
      }
    } catch { /* not found */ }
  }

  // Last resort: ask gh CLI (works on any platform where gh is installed)
  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (token) return token;
  } catch { /* gh not available or not logged in */ }

  throw new Error('No GitHub token found for Copilot (set GITHUB_TOKEN, GH_TOKEN, or COPILOT_GITHUB_TOKEN, or run: gh auth login)');
}

async function resolveCopilotToken(): Promise<{ token: string; baseUrl: string }> {
  // Check memory cache
  if (cachedToken && isUsable(cachedToken)) {
    return { token: cachedToken.token, baseUrl: deriveBaseUrl(cachedToken.token) };
  }
  // Check disk cache
  const disk = loadCachedToken();
  if (disk && isUsable(disk)) {
    cachedToken = disk;
    return { token: disk.token, baseUrl: deriveBaseUrl(disk.token) };
  }

  // Exchange GitHub PAT for copilot session token
  const ghToken = await resolveGitHubToken();
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${ghToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);

  const json = await res.json() as Record<string, unknown>;
  const token = json.token as string;
  let expiresAt = json.expires_at as number;
  if (expiresAt < 10_000_000_000) expiresAt *= 1000; // seconds → ms

  const entry: CachedToken = { token, expiresAt, updatedAt: Date.now() };
  cachedToken = entry;
  saveCachedToken(entry);

  return { token, baseUrl: deriveBaseUrl(token) };
}

async function* streamCopilot(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  let attempts = 0;
  while (attempts < 2) {
    const { token, baseUrl } = await resolveCopilotToken();

    // Copilot uses OpenAI-compatible API with extra headers
    const copilotConfig: ProviderConfig = {
      ...config,
      apiKey: token,
      baseUrl: config.baseUrl ?? baseUrl,
      extraHeaders: {
        'Editor-Version': 'vscode/1.96.2',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'Copilot-Integration-Id': 'vscode-chat',
        'Openai-Intent': 'conversation-panel',
      },
    } as ProviderConfig & { extraHeaders: Record<string, string> };

    try {
      yield* openaiProvider.stream(messages, tools, copilotConfig);
      return; // success
    } catch (err: any) {
      // If 401 (token expired mid-stream), invalidate cache and retry once
      if (attempts === 0 && (err?.status === 401 || err?.message?.includes('401'))) {
        console.warn('[copilot] Token expired mid-stream, refreshing...');
        cachedToken = null;
        attempts++;
        continue;
      }
      throw err;
    }
  }
}

export const githubCopilotProvider: Provider = {
  name: 'github-copilot',
  stream: streamCopilot,
};
