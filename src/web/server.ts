/**
 * Symbiote Web UI Server
 * Zero dependencies — native Node.js http + SSE streaming
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { palette, ok } from '../cli/brand.js';
import { loadConfig } from '../config/config.js';
import { APP_VERSION } from '../meta/version.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  name: string;
  systemPrompt: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  tokensUsed: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  toolCalls?: ToolCall[];
  iterations?: number;
  temperatureHistory?: Array<{ iteration: number; category: string; temperature: number }>;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
}

interface Config {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKeys: Record<string, string>;
}

interface SubAgent {
  id: string;
  label: string;
  status: 'running' | 'done' | 'killed';
  startedAt: number;
}

export interface WebControlPlane {
  getStatus: () => Record<string, unknown>;
  getConfig: () => Record<string, unknown>;
  getSessions: () => unknown[];
  getSessionMessages: (id: string) => unknown[] | null;
  createSession: (name?: string) => unknown;
  hasSession: (id: string) => boolean;
  archiveSession: (id: string) => boolean;
  getTools: () => unknown[];
  chat: (
    request: { text: string; sessionId: string; senderId: string; senderName: string; source: string },
    emit?: (event: Record<string, unknown>) => void,
  ) => Promise<unknown>;
  interruptSession: (id: string) => boolean;
  getRuns: () => unknown[];
  startRun: (request: { name?: string; prompt: string; sessionId: string }) => unknown;
  stopRun: (id: string) => boolean;
  restartRun: (id: string) => unknown | null;
  guideRun: (id: string, message: string) => unknown | null;
  updateIdentity: (identity: {
    name: string;
    emoji: string;
    soulContent: string;
    agentsContent: string;
    instructions: string;
  }) => unknown;
  getAgents: () => unknown[];
  controlAgent: (id: string, action: 'stop' | 'steer', message?: string) => boolean;
  getMemoryGraph: () => unknown;
  getMemoryDocument: (id: string) => unknown | null;
  browserNavigate: (url: string) => Promise<unknown>;
  browserCapture: () => Promise<unknown>;
  browserControl: (action: 'click' | 'move' | 'type' | 'press' | 'scroll', params: Record<string, unknown>) => Promise<void>;
  getChessState: () => unknown;
  saveChessState: (state: Record<string, unknown>) => unknown;
  webAccessToken?: string;
  logPath: string;
}

// ── State ──────────────────────────────────────────────────────────────────

const startTime = Date.now();
const sessions = new Map<string, Session>();
const subAgents: SubAgent[] = [];
let totalTokens = 0;

let config: Config = {
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  temperature: 0.7,
  maxTokens: 8192,
  apiKeys: {},
};

// Agent identity (from symbiote.json)
let agentName = 'Agent';
let agentEmoji = '🤖';

const configPath = path.resolve(process.cwd(), 'symbiote.json');

// Load config from symbiote.json if exists
try {
  const loaded = loadConfig();
  if (loaded.name) agentName = loaded.name;
  if (loaded.emoji) agentEmoji = loaded.emoji;
  if (loaded.defaultProvider) config.provider = loaded.defaultProvider;
  if (loaded.defaultModel) config.model = loaded.defaultModel;
  config = { ...config, ...loaded };
} catch { /* no config file yet */ }

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return crypto.randomUUID();
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function redactKeys(keys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) {
    out[k] = v ? v.slice(0, 6) + '•'.repeat(Math.max(0, v.length - 10)) + v.slice(-4) : '';
  }
  return out;
}

function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patParts = pattern.split('/');
  const urlParts = pathname.split('/');
  if (patParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = urlParts[i];
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

// ── Providers (simulated for now — will integrate real APIs) ───────────────

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'] },

  { id: 'github-copilot', name: 'GitHub Copilot', models: ['claude-opus-4-6', 'claude-sonnet-4-20250514', 'gpt-4o', 'o3-mini'] },
  { id: 'gladius', name: 'Local (Gladius)', models: ['gladius-125m', 'gladius-1b'] },
];

const TOOLS = [
  { name: 'read', description: 'Read file contents' },
  { name: 'write', description: 'Create or overwrite files' },
  { name: 'edit', description: 'Make precise edits to files' },
  { name: 'exec', description: 'Run shell commands' },
  { name: 'web_fetch', description: 'Fetch URL content' },
  { name: 'browser', description: 'Control web browser' },
  { name: 'image', description: 'Analyze images' },
];

// ── Real chat streaming (proxies to HTTP API on port 3006) ─────────────────

async function streamChat(
  res: http.ServerResponse,
  sessionId: string,
  userMessage: string
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    json(res, { error: 'Session not found' }, 404);
    return;
  }

  // Add user message to local session
  const userMsg: Message = {
    id: uid(),
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
    tokensIn: Math.ceil(userMessage.length / 4),
  };
  session.messages.push(userMsg);

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const startMs = Date.now();
  const assistantId = uid();

  try {
    // Proxy to real HTTP API (port 3006) which runs through the actual agent pipeline
    const apiPort = parseInt(process.env.SYMBIOTE_API_PORT ?? String((config as any).apiPort ?? process.env.SYMBIOTE_PORT ?? 3006), 10);
    const apiHost = process.env.SYMBIOTE_API_HOST ?? String((config as any).apiHost ?? '127.0.0.1');
    const apiKey = process.env.SYMBIOTE_API_KEY ?? process.env.API_KEY ?? '';
    const payload = JSON.stringify({ sessionId, message: userMessage, senderId: 'webchat-owner', source: 'webchat' });

    const apiRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const apiReq = http.request({
        hostname: apiHost,
        port: apiPort,
        path: '/api/v1/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 86400000, // 24h timeout for long agent runs
      }, resolve);
      apiReq.on('error', reject);
      apiReq.on('timeout', () => { apiReq.destroy(); reject(new Error('API timeout')); });
      apiReq.write(payload);
      apiReq.end();
    });

    if (apiRes.statusCode !== 200) {
      const chunks: Buffer[] = [];
      for await (const chunk of apiRes) chunks.push(chunk as Buffer);
      const errBody = Buffer.concat(chunks).toString();
      let errMsg = 'API error';
      try { errMsg = JSON.parse(errBody).error || errMsg; } catch { /* ignore */ }
      res.write(`data: ${JSON.stringify({ type: 'text', content: `Error: ${errMsg}`, id: assistantId })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', message: { latencyMs: Date.now() - startMs } })}\n\n`);
      res.end();
      return;
    }

    // Forward SSE events from real API to webchat client
    let fullContent = '';
    let doneMeta: { latencyMs?: number; iterations?: number; toolCalls?: ToolCall[]; temperatureHistory?: Array<{ iteration: number; category: string; temperature: number }> } = {};
    let buffer = '';

    apiRes.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;

        try {
          const data = JSON.parse(dataStr);
          if (data.type === 'text') {
            fullContent += data.content;
            // Forward with our assistant ID
            res.write(`data: ${JSON.stringify({ type: 'text', content: data.content, id: assistantId })}\n\n`);
          } else if (data.type === 'tool_start' || data.type === 'tool_end') {
            // Forward tool call events as-is
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } else if (data.type === 'done') {
            doneMeta = data.message ?? {};
          }
        } catch { /* skip unparseable lines */ }
      }
    });

    await new Promise<void>((resolve) => {
      apiRes.on('end', resolve);
      apiRes.on('error', () => resolve());
    });

    // Process any remaining buffer
    if (buffer.startsWith('data: ')) {
      const dataStr = buffer.slice(6).trim();
      if (dataStr) {
        try {
          const data = JSON.parse(dataStr);
          if (data.type === 'text') fullContent += data.content;
        } catch { /* ignore */ }
      }
    }

    const latency = Date.now() - startMs;
    const tokensOut = Math.ceil(fullContent.length / 4);
    totalTokens += (userMsg.tokensIn ?? 0) + tokensOut;
    session.tokensUsed += (userMsg.tokensIn ?? 0) + tokensOut;

    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: fullContent || '(no response)',
      timestamp: Date.now(),
      tokensIn: userMsg.tokensIn,
      tokensOut,
      latencyMs: doneMeta.latencyMs ?? latency,
      toolCalls: Array.isArray(doneMeta.toolCalls) ? doneMeta.toolCalls : [],
      iterations: typeof doneMeta.iterations === 'number' ? doneMeta.iterations : undefined,
      temperatureHistory: Array.isArray(doneMeta.temperatureHistory) ? doneMeta.temperatureHistory : [],
    };
    session.messages.push(assistantMsg);
    session.updatedAt = Date.now();

    res.write(`data: ${JSON.stringify({ type: 'done', message: assistantMsg })}\n\n`);
    res.end();

  } catch (err) {
    const latency = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`  [symbiote-web] Chat proxy error: ${errMsg}`);

    // Send error as assistant message so user sees it
    const errorContent = `Connection to agent failed: ${errMsg}. Make sure the Symbiote agent is running.`;
    res.write(`data: ${JSON.stringify({ type: 'text', content: errorContent, id: assistantId })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', message: { id: assistantId, role: 'assistant', content: errorContent, timestamp: Date.now(), latencyMs: latency } })}\n\n`);
    res.end();
  }
}

// ── Serve static files ─────────────────────────────────────────────────────

function serveStatic(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath);
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ── Router ─────────────────────────────────────────────────────────────────

const SERVER_DIR = path.resolve(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)));
const WEBAPP_DIR = path.resolve(SERVER_DIR, '../../webapp/dist');
const LEGACY_WEB_DIR = path.resolve(SERVER_DIR, '../../web');

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || (address?.startsWith('::ffff:127.') ?? false);
}

function hasValidAccessToken(req: http.IncomingMessage, expected: string): boolean {
  const authorization = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const actual = Buffer.from(expected);
  return provided.length === actual.length && crypto.timingSafeEqual(provided, actual);
}

function tailFile(filename: string, requestedLines: number): string {
  const lines = Math.min(Math.max(Math.trunc(requestedLines) || 100, 1), 300);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, 'r');
    const size = fs.fstatSync(fd).size;
    const chunkSize = 64 * 1024;
    const maxBytes = 512 * 1024;
    let position = size;
    let remaining = Math.min(size, maxBytes);
    const chunks: Buffer[] = [];
    while (remaining > 0) {
      const length = Math.min(chunkSize, remaining);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, chunk, 0, length, position);
      if (bytesRead === 0) break;
      chunks.unshift(chunk.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, control?: WebControlPlane): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  if (control && method === 'GET' && pathname === '/api/access') {
    const required = !isLoopbackRequest(req);
    return json(res, {
      required,
      authenticated: !required || (!!control.webAccessToken && hasValidAccessToken(req, control.webAccessToken)),
    });
  }

  if (control && method === 'GET' && pathname === '/api/access/token') {
    const origin = req.headers.origin;
    const requestOrigin = req.headers.host ? `http://${req.headers.host}` : '';
    if (!isLoopbackRequest(req) || (origin && origin !== requestOrigin)) {
      return json(res, { error: 'LAN access tokens can only be viewed from the local control room.' }, 403);
    }
    res.setHeader('Cache-Control', 'no-store');
    return json(res, { token: control.webAccessToken ?? '' });
  }

  if (control && pathname.startsWith('/api/')) {
    if (!isLoopbackRequest(req) && (!control.webAccessToken || !hasValidAccessToken(req, control.webAccessToken))) {
      return json(res, { error: 'A valid LAN access token is required.' }, 401);
    }

    if (method === 'GET' && pathname === '/api/status') {
      return json(res, control.getStatus());
    }
    if (method === 'GET' && pathname === '/api/config') {
      return json(res, control.getConfig());
    }
    if (method === 'PUT' && pathname === '/api/identity') {
      const body = JSON.parse(await readBody(req) || '{}') as {
        name?: unknown;
        emoji?: unknown;
        soulContent?: unknown;
        agentsContent?: unknown;
        instructions?: unknown;
      };
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) {
        return json(res, { error: 'Agent name must contain 1–80 characters.' }, 400);
      }
      if (typeof body.emoji !== 'string' || !['🤖', '🧠', '🧭', '🌿', '✨'].includes(body.emoji)) {
        return json(res, { error: 'Choose a supported agent icon.' }, 400);
      }
      if (typeof body.soulContent !== 'string' || body.soulContent.length > 100_000) {
        return json(res, { error: 'SOUL.md content must be 100,000 characters or fewer.' }, 413);
      }
      if (typeof body.agentsContent !== 'string' || body.agentsContent.length > 100_000) {
        return json(res, { error: 'AGENTS.md content must be 100,000 characters or fewer.' }, 413);
      }
      if (typeof body.instructions !== 'string' || body.instructions.length > 20_000) {
        return json(res, { error: 'Agent instructions must be 20,000 characters or fewer.' }, 413);
      }
      return json(res, control.updateIdentity({
        name: body.name.trim(),
        emoji: body.emoji,
        soulContent: body.soulContent,
        agentsContent: body.agentsContent,
        instructions: body.instructions,
      }));
    }
    if (method === 'GET' && pathname === '/api/sessions') {
      return json(res, control.getSessions());
    }
    if (method === 'GET' && pathname === '/api/memory/graph') {
      return json(res, control.getMemoryGraph());
    }
    const memoryDocument = matchRoute('/api/memory/documents/:id', pathname);
    if (method === 'GET' && memoryDocument) {
      const document = control.getMemoryDocument(decodeURIComponent(memoryDocument.id));
      return document ? json(res, document) : json(res, { error: 'Memory document not found.' }, 404);
    }
    const archiveAction = matchRoute('/api/sessions/:id', pathname);
    if (method === 'DELETE' && archiveAction) {
      const id = decodeURIComponent(archiveAction.id);
      return control.archiveSession(id)
        ? json(res, { archived: true })
        : json(res, { error: 'Conversation is active, unavailable, or cannot be archived.' }, 409);
    }
    if (method === 'GET' && pathname === '/api/tools') {
      return json(res, control.getTools());
    }
    if (method === 'GET' && pathname === '/api/games/chess') {
      return json(res, { state: control.getChessState() });
    }
    if (method === 'PUT' && pathname === '/api/games/chess') {
      const body = JSON.parse(await readBody(req) || '{}') as { state?: unknown };
      const state = body.state;
      if (!state || typeof state !== 'object' || Array.isArray(state)) return json(res, { error: 'A valid chess state is required.' }, 400);
      const value = state as Record<string, unknown>;
      const score = value.score as Record<string, unknown> | null;
      const result = value.result as Record<string, unknown> | null;
      const history = value.history;
      if (value.version !== 1 || !score || typeof score !== 'object' || Array.isArray(score)
        || !['rating', 'wins', 'losses', 'draws'].every(key => typeof score[key] === 'number' && Number.isSafeInteger(score[key]))
        || (score.rating as number) < 100 || (score.rating as number) > 100_000
        || ['wins', 'losses', 'draws'].some(key => (score[key] as number) < 0 || (score[key] as number) > 10_000_000)
        || !['adaptive', '1', '2', '3', '4', '5'].includes(String(value.difficulty))
        || typeof value.fen !== 'string' || value.fen.length > 120
        || typeof value.pgn !== 'string' || value.pgn.length > 30_000
        || !Array.isArray(history) || history.length > 100
        || history.some(item => !item || typeof item !== 'object' || Array.isArray(item)
          || !['win', 'loss', 'draw'].includes(String((item as Record<string, unknown>).outcome))
          || typeof (item as Record<string, unknown>).delta !== 'number' || !Number.isSafeInteger((item as Record<string, unknown>).delta)
          || typeof (item as Record<string, unknown>).opponentRating !== 'number' || !Number.isSafeInteger((item as Record<string, unknown>).opponentRating)
          || typeof (item as Record<string, unknown>).completedAt !== 'number' || !Number.isSafeInteger((item as Record<string, unknown>).completedAt)
          || typeof (item as Record<string, unknown>).pgn !== 'string' || ((item as Record<string, unknown>).pgn as string).length > 30_000)
        || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt)
        || (result !== null && (!result || typeof result !== 'object' || Array.isArray(result)
          || !['win', 'loss', 'draw'].includes(String(result.outcome))
          || typeof result.delta !== 'number' || !Number.isSafeInteger(result.delta)))) {
        return json(res, { error: 'Chess state fields are invalid or outside supported limits.' }, 400);
      }
      return json(res, { state: control.saveChessState(value) });
    }
    if (method === 'GET' && pathname === '/api/browser/snapshot') {
      return json(res, await control.browserCapture());
    }
    if (method === 'POST' && pathname === '/api/browser/navigate') {
      const body = JSON.parse(await readBody(req) || '{}') as { url?: unknown };
      if (typeof body.url !== 'string' || body.url.length > 4_000) return json(res, { error: 'A valid browser URL is required.' }, 400);
      let target: URL;
      try {
        target = new URL(body.url.includes('://') ? body.url : `https://${body.url}`);
      } catch {
        return json(res, { error: 'The browser URL is invalid.' }, 400);
      }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        return json(res, { error: 'Only HTTP and HTTPS browser URLs are supported.' }, 400);
      }
      return json(res, await control.browserNavigate(target.toString()));
    }
    if (method === 'POST' && pathname === '/api/browser/action') {
      const body = JSON.parse(await readBody(req) || '{}') as { action?: unknown; x?: unknown; y?: unknown; text?: unknown; key?: unknown; deltaX?: unknown; deltaY?: unknown };
      if (body.action === 'click' || body.action === 'move') {
        if (![body.x, body.y].every(value => typeof value === 'number' && Number.isFinite(value))) return json(res, { error: 'Finite browser viewport coordinates are required.' }, 400);
        await control.browserControl(body.action, { x: body.x, y: body.y });
      } else if (body.action === 'type') {
        if (typeof body.text !== 'string' || body.text.length > 8_000) return json(res, { error: 'Browser input must be 8,000 characters or fewer.' }, 400);
        await control.browserControl('type', { text: body.text });
      } else if (body.action === 'press') {
        if (typeof body.key !== 'string' || body.key.length > 80) return json(res, { error: 'A valid keyboard key or chord is required.' }, 400);
        await control.browserControl('press', { key: body.key });
      } else if (body.action === 'scroll') {
        if (![body.x, body.y, body.deltaX, body.deltaY].every(value => typeof value === 'number' && Number.isFinite(value))) return json(res, { error: 'Finite browser scroll coordinates and deltas are required.' }, 400);
        await control.browserControl('scroll', { x: body.x, y: body.y, delta_x: body.deltaX, delta_y: body.deltaY });
      } else {
        return json(res, { error: 'Unsupported browser action.' }, 400);
      }
      return json(res, await control.browserCapture());
    }
    if (method === 'GET' && pathname === '/api/runs') {
      return json(res, control.getRuns());
    }
    if (method === 'POST' && pathname === '/api/runs') {
      const body = JSON.parse(await readBody(req) || '{}') as { name?: unknown; prompt?: unknown; sessionId?: unknown };
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return json(res, { error: 'A non-empty task prompt is required.' }, 400);
      }
      if (body.prompt.length > 20_000) {
        return json(res, { error: 'Task prompts must be 20,000 characters or fewer.' }, 413);
      }
      if (typeof body.sessionId !== 'string' || !body.sessionId.trim() || body.sessionId.length > 200) {
        return json(res, { error: 'A valid conversation sessionId is required.' }, 400);
      }
      const sessionId = body.sessionId.trim();
      if (!control.hasSession(sessionId)) return json(res, { error: 'Conversation session was not found.' }, 404);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : undefined;
      return json(res, control.startRun({ name, prompt: body.prompt.trim(), sessionId }), 201);
    }
    const restartRunAction = matchRoute('/api/runs/:id/restart', pathname);
    if (method === 'POST' && restartRunAction) {
      const run = control.restartRun(decodeURIComponent(restartRunAction.id));
      return run ? json(res, run, 201) : json(res, { error: 'Run cannot be restarted because it is missing or still active.' }, 409);
    }
    const guideRunAction = matchRoute('/api/runs/:id/guide', pathname);
    if (method === 'POST' && guideRunAction) {
      const body = JSON.parse(await readBody(req) || '{}') as { message?: unknown };
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return json(res, { error: 'A non-empty guidance message is required.' }, 400);
      }
      if (body.message.length > 2_000) {
        return json(res, { error: 'Guidance messages must be 2,000 characters or fewer.' }, 413);
      }
      const run = control.guideRun(decodeURIComponent(guideRunAction.id), body.message.trim());
      return run ? json(res, run, 202) : json(res, { error: 'Task could not be guided because its run or session is unavailable.' }, 409);
    }
    if (method === 'GET' && pathname === '/api/agents') {
      return json(res, control.getAgents());
    }
    const runAction = matchRoute('/api/runs/:id/stop', pathname);
    if (method === 'POST' && runAction) {
      const id = decodeURIComponent(runAction.id);
      return control.stopRun(id)
        ? json(res, { stopped: true })
        : json(res, { error: 'Run is no longer active or could not be stopped.' }, 409);
    }
    const agentAction = matchRoute('/api/agents/:id/action', pathname);
    if (method === 'POST' && agentAction) {
      const id = decodeURIComponent(agentAction.id);
      const body = JSON.parse(await readBody(req) || '{}') as { action?: unknown; message?: unknown };
      if (body.action !== 'stop' && body.action !== 'steer') {
        return json(res, { error: 'Action must be "stop" or "steer".' }, 400);
      }
      if (body.action === 'steer' && (typeof body.message !== 'string' || !body.message.trim())) {
        return json(res, { error: 'A non-empty steering message is required.' }, 400);
      }
      if (typeof body.message === 'string' && body.message.length > 2_000) {
        return json(res, { error: 'Steering messages must be 2,000 characters or fewer.' }, 413);
      }
      return control.controlAgent(id, body.action, typeof body.message === 'string' ? body.message.trim() : undefined)
        ? json(res, { accepted: true })
        : json(res, { error: 'Agent is no longer active or could not be controlled.' }, 409);
    }
    if (method === 'GET' && pathname === '/api/logs') {
      return json(res, { lines: tailFile(control.logPath, Number(url.searchParams.get('lines'))) });
    }
    let controlParams = matchRoute('/api/sessions/:id/messages', pathname);
    if (method === 'GET' && controlParams) {
      const messages = control.getSessionMessages(decodeURIComponent(controlParams.id));
      return messages ? json(res, messages) : json(res, { error: 'Session not found' }, 404);
    }
    if (method === 'POST' && pathname === '/api/sessions') {
      const body = JSON.parse(await readBody(req) || '{}') as { name?: unknown };
      return json(res, control.createSession(typeof body.name === 'string' ? body.name : undefined), 201);
    }
    if (method === 'POST' && pathname === '/api/chat') {
      const body = JSON.parse(await readBody(req) || '{}') as { text?: unknown; sessionId?: unknown };
      if (typeof body.text !== 'string' || !body.text.trim() || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
        return json(res, { error: 'A non-empty text and sessionId are required.' }, 400);
      }
      const sessionId = body.sessionId.trim();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      const emit = (event: Record<string, unknown>) => {
        if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        const result = await control.chat({
        text: body.text,
        sessionId,
        senderId: 'webapp-local',
        senderName: 'Local operator',
        source: 'webapp',
        }, emit);
        emit({ type: 'done', result });
      } catch (failure) {
        emit({ type: 'error', error: failure instanceof Error ? failure.message : 'The agent turn failed.' });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }
    const interruptSession = matchRoute('/api/sessions/:id/interrupt', pathname);
    if (method === 'POST' && interruptSession) {
      const stopped = control.interruptSession(decodeURIComponent(interruptSession.id));
      return stopped
        ? json(res, { interrupted: true })
        : json(res, { error: 'No active turn was found for this conversation.' }, 409);
    }
  }

  // ── API Routes ─────────────────────────────────────────────────────────

  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    return json(res, {
      uptime: Date.now() - startTime,
      uptimeHuman: formatUptime(Date.now() - startTime),
      sessions: sessions.size,
      totalTokens,
      model: config.model,
      provider: config.provider,
      version: APP_VERSION,
      agentName,
      agentEmoji,
    });
  }

  // GET /api/providers
  if (method === 'GET' && pathname === '/api/providers') {
    return json(res, PROVIDERS);
  }

  // GET /api/tools
  if (method === 'GET' && pathname === '/api/tools') {
    return json(res, TOOLS);
  }

  // GET /api/config
  if (method === 'GET' && pathname === '/api/config') {
    return json(res, {
      ...config,
      apiKeys: redactKeys(config.apiKeys),
      agentName,
      agentEmoji,
      version: APP_VERSION,
    });
  }

  // PUT /api/config
  if (method === 'PUT' && pathname === '/api/config') {
    const body = JSON.parse(await readBody(req));
    config = { ...config, ...body };
    // Don't overwrite keys with redacted versions
    if (body.apiKeys) {
      for (const [k, v] of Object.entries(body.apiKeys as Record<string, string>)) {
        if (v && !v.includes('•')) config.apiKeys[k] = v;
      }
    }
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch { /* ignore */ }
    return json(res, { ok: true });
  }

  // GET /api/sessions
  if (method === 'GET' && pathname === '/api/sessions') {
    const list = Array.from(sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      messageCount: s.messages.length,
      lastMessage: s.messages.length > 0
        ? s.messages[s.messages.length - 1].content.slice(0, 100)
        : '',
      tokensUsed: s.tokensUsed,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return json(res, list);
  }

  // POST /api/sessions
  if (method === 'POST' && pathname === '/api/sessions') {
    const body = JSON.parse(await readBody(req) || '{}');
    const session: Session = {
      id: uid(),
      name: body.name || `Session ${sessions.size + 1}`,
      systemPrompt: body.systemPrompt || '',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokensUsed: 0,
    };
    if (session.systemPrompt) {
      session.messages.push({
        id: uid(),
        role: 'system',
        content: session.systemPrompt,
        timestamp: Date.now(),
      });
    }
    sessions.set(session.id, session);
    return json(res, session, 201);
  }

  // DELETE /api/sessions/:id
  let params = matchRoute('/api/sessions/:id', pathname);
  if (method === 'DELETE' && params) {
    sessions.delete(params.id);
    return json(res, { ok: true });
  }

  // GET /api/sessions/:id/messages
  params = matchRoute('/api/sessions/:id/messages', pathname);
  if (method === 'GET' && params) {
    const session = sessions.get(params.id);
    if (!session) return json(res, { error: 'Not found' }, 404);
    return json(res, session.messages);
  }

  // POST /api/chat
  if (method === 'POST' && pathname === '/api/chat') {
    const body = JSON.parse(await readBody(req));
    const { sessionId, message } = body;
    if (!sessionId || !message) return json(res, { error: 'sessionId and message required' }, 400);
    // Auto-create server-side session if webchat created it locally
    if (!sessions.has(sessionId)) {
      const autoSession: Session = {
        id: sessionId,
        name: 'Web Chat',
        systemPrompt: '',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tokensUsed: 0,
      };
      sessions.set(sessionId, autoSession);
    }
    return streamChat(res, sessionId, message);
  }

  // GET /api/agents
  if (method === 'GET' && pathname === '/api/agents') {
    return json(res, subAgents);
  }

  // DELETE /api/agents/:id
  params = matchRoute('/api/agents/:id', pathname);
  if (method === 'DELETE' && params) {
    const agent = subAgents.find(a => a.id === params!.id);
    if (agent) agent.status = 'killed';
    return json(res, { ok: true });
  }

  // ── Static Files ───────────────────────────────────────────────────────

  if (method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      const appIndex = path.join(WEBAPP_DIR, 'index.html');
      if (fs.existsSync(appIndex)) return serveStatic(res, appIndex);
      return serveStatic(res, path.join(LEGACY_WEB_DIR, 'index.html'));
    }
    // Serve other static files
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    const appFile = path.join(WEBAPP_DIR, safePath);
    if (fs.existsSync(appFile)) return serveStatic(res, appFile);
    return serveStatic(res, path.join(LEGACY_WEB_DIR, safePath));
  }

  // 404
  json(res, { error: 'Not found' }, 404);
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ── Server ─────────────────────────────────────────────────────────────────

export function startWebServer(port = 3006, host = '127.0.0.1', control?: WebControlPlane): http.Server {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, control).catch(err => {
      console.error(`${palette.dim}  [symbiote-web]${palette.reset}`, err);
      if (!res.headersSent) {
        json(res, { error: 'Internal server error' }, 500);
      }
    });
  });

  // Create a default session
  const defaultSession: Session = {
    id: uid(),
    name: 'Default Session',
    systemPrompt: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tokensUsed: 0,
  };
  sessions.set(defaultSession.id, defaultSession);

  server.listen(port, host, () => {
    console.log(ok(`Web UI → ${palette.cyan}http://${host}:${port}${palette.reset}`));
  });

  return server;
}

// Run directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const port = parseInt(process.env.SYMBIOTE_PORT ?? String((config as any).webPort ?? 3009), 10);
  startWebServer(port);
}
