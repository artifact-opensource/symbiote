// Symbiote — Builtin tool: vision analysis
// Routes through GitHub Copilot (OpenAI-compatible proxy) for vision.
// NO direct Anthropic/OpenAI API calls — we pay for Copilot, use Copilot.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types.js';

// ── Copilot token resolution (mirrors github-copilot.ts provider) ──

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_COPILOT_BASE = 'https://api.individual.githubcopilot.com';

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function tokenCachePath(): string {
  return path.join(os.homedir(), '.symbiote', 'credentials', 'github-copilot.token.json');
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
  return t.expiresAt - Date.now() > 5 * 60 * 1000;
}

function deriveBaseUrl(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const ep = match?.[1]?.trim();
  if (!ep) return DEFAULT_COPILOT_BASE;
  const host = ep.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.');
  return `https://${host}`;
}

async function resolveGitHubToken(): Promise<string> {
  const home = os.homedir();

  const copilotEnv = process.env.COPILOT_GITHUB_TOKEN;
  if (copilotEnv?.trim()) return copilotEnv.trim();

  const copilotCliPath = path.join(home, '.copilot-cli-access-token');
  try {
    const cliToken = fs.readFileSync(copilotCliPath, 'utf-8').trim();
    if (cliToken) return cliToken;
  } catch { /* not found */ }

  const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  // Unix/macOS hosts.json
  const hostsPath = path.join(home, '.config', 'github-copilot', 'hosts.json');
  try {
    const hosts = JSON.parse(fs.readFileSync(hostsPath, 'utf-8'));
    for (const key of Object.keys(hosts)) {
      if (hosts[key]?.oauth_token) return hosts[key].oauth_token;
    }
  } catch { /* not found */ }

  // Windows: %APPDATA%\github-copilot\hosts.json
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

  // Last resort: gh CLI
  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (token) return token;
  } catch { /* gh not available */ }

  throw new Error('No GitHub token found for Copilot vision');
}

async function getCopilotToken(): Promise<{ token: string; baseUrl: string }> {
  if (cachedToken && isUsable(cachedToken)) {
    return { token: cachedToken.token, baseUrl: deriveBaseUrl(cachedToken.token) };
  }
  const disk = loadCachedToken();
  if (disk && isUsable(disk)) {
    cachedToken = disk;
    return { token: disk.token, baseUrl: deriveBaseUrl(disk.token) };
  }

  const ghToken = await resolveGitHubToken();
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${ghToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);

  const json = await res.json() as Record<string, unknown>;
  const token = json.token as string;
  let expiresAt = json.expires_at as number;
  if (expiresAt < 10_000_000_000) expiresAt *= 1000;

  const entry: CachedToken = { token, expiresAt };
  cachedToken = entry;
  saveCachedToken(entry);

  return { token, baseUrl: deriveBaseUrl(token) };
}

// ── Vision call through Copilot proxy ──

async function callCopilotVision(base64: string, mediaType: string, prompt: string): Promise<string> {
  const { token, baseUrl } = await getCopilotToken();

  // Copilot proxy uses OpenAI-compatible format, no /v1 prefix
  const endpoint = baseUrl.includes('githubcopilot.com')
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Editor-Version': 'vscode/1.96.2',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Copilot-Integration-Id': 'vscode-chat',
      'Openai-Intent': 'conversation-panel',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${base64}` },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    return `Error: Copilot Vision API returned ${res.status}: ${errText}`;
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? 'No analysis returned.';
}

// ── Tool definition ──

export const imageTool: ToolDefinition = {
  name: 'image',
  description: 'Analyze an image with a vision model. Accepts a local file path or URL. Returns the model\'s analysis.',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'Image path (local file) or URL' },
      prompt: { type: 'string', description: 'What to analyze or ask about the image (default: "Describe this image")' },
    },
    required: ['image'],
  },
  async execute(input) {
    const imagePath = input.image as string;
    const prompt = (input.prompt as string) ?? 'Describe this image in detail.';

    // ── Resolve image to base64 ──
    let imageBase64: string;
    let mediaType: string;

    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      try {
        const res = await fetch(imagePath, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return `Error: Failed to fetch image: HTTP ${res.status}`;
        const buffer = Buffer.from(await res.arrayBuffer());
        imageBase64 = buffer.toString('base64');
        mediaType = res.headers.get('content-type') ?? 'image/jpeg';
      } catch (err) {
        return `Error: Failed to fetch image: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      const resolved = path.resolve(imagePath);
      if (!fs.existsSync(resolved)) return `Error: Image not found: ${resolved}`;

      const stat = fs.statSync(resolved);
      if (stat.size > 20 * 1024 * 1024) return `Error: Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 20MB)`;

      const ext = path.extname(resolved).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      };
      mediaType = mimeMap[ext] ?? 'image/png';
      imageBase64 = fs.readFileSync(resolved).toString('base64');
    }

    // ── Call vision through Copilot ──
    return await callCopilotVision(imageBase64, mediaType, prompt);
  },
};
