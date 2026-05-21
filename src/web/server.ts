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
import { loadConfig, type SymbioteConfigType } from '../config/config.js';

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
}

interface ToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
}

interface Config {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKeys: Record<string, string>;
}

interface ProviderSummary {
  id: string;
  name: string;
  active?: boolean;
  configured?: boolean;
}

interface UiCopy {
  appName: string;
  brandName: string;
  brandUrl: string;
  welcomeTitle: string;
  welcomeTemplate: string;
  emptySessionsLabel: string;
  defaultSessionTitle: string;
  sendPlaceholder: string;
  composerHint: string;
  composerHintSecondary: string;
  suggestionPrompts: string[];
}

interface SubAgent {
  id: string;
  label: string;
  status: 'running' | 'done' | 'killed';
  startedAt: number;
}

interface WebServerOptions {
  port?: number;
  host?: string;
  apiPort?: number;
  apiHost?: string;
  apiKey?: string;
  version?: string;
  agentName?: string;
  agentEmoji?: string;
  providers?: ProviderSummary[];
  tools?: Array<Pick<ToolCall, 'name'> & { description?: string }>;
  ui?: Partial<UiCopy>;
}

interface PackageMetadata {
  appName: string;
  version: string;
  brandName: string;
  brandUrl: string;
}

type RuntimeConfig = Config & Partial<SymbioteConfigType> & Record<string, unknown>;

// ── State ──────────────────────────────────────────────────────────────────

const startTime = Date.now();
const sessions = new Map<string, Session>();
const subAgents: SubAgent[] = [];
let totalTokens = 0;
const packageMetadata = loadPackageMetadata();

let config: RuntimeConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  temperature: 0.7,
  maxTokens: 8192,
  apiKeys: {},
};

let runtimeOptions: Required<WebServerOptions> = {
  port: 3009,
  host: '127.0.0.1',
  apiPort: 3006,
  apiHost: '127.0.0.1',
  apiKey: process.env.MACH6_API_KEY ?? process.env.API_KEY ?? '',
  version: packageMetadata.version,
  agentName: 'Agent',
  agentEmoji: '🤖',
  providers: [],
  tools: [],
  ui: createDefaultUiCopy(packageMetadata),
};

// Agent identity (from mach6.json)
let agentName = 'Agent';
let agentEmoji = '🤖';

// Load config from mach6.json if exists
const configPath = path.resolve(process.cwd(), 'mach6.json');
try {
  const loaded = loadConfig(configPath) as RuntimeConfig;
  if (typeof loaded.name === 'string' && loaded.name) agentName = loaded.name;
  if (typeof loaded.emoji === 'string' && loaded.emoji) agentEmoji = loaded.emoji;
  config = {
    ...config,
    ...loaded,
    provider: loaded.defaultProvider ?? config.provider,
    model: loaded.defaultModel ?? config.model,
  };
  runtimeOptions = {
    ...runtimeOptions,
    agentName,
    agentEmoji,
    providers: deriveProviderSummaries(loaded, config.provider),
  };
} catch { /* no config file yet */ }

applyRuntimeOptions({});

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

function loadPackageMetadata(): PackageMetadata {
  const packagePaths = [
    path.join(process.cwd(), 'package.json'),
    path.join(path.resolve(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)), '../..'), 'package.json'),
  ];

  for (const packagePath of packagePaths) {
    try {
      const raw = fs.readFileSync(packagePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const author = typeof parsed.author === 'string' ? parsed.author.split('<')[0]?.trim() : '';
      const appName = typeof parsed.name === 'string' && parsed.name
        ? parsed.name.charAt(0).toUpperCase() + parsed.name.slice(1)
        : 'Symbiote';
      return {
        appName,
        version: typeof parsed.version === 'string' ? parsed.version : '0.1.0',
        brandName: author || appName,
        brandUrl: typeof parsed.homepage === 'string' ? parsed.homepage : '',
      };
    } catch {
      continue;
    }
  }

  return {
    appName: 'Symbiote',
    version: '0.1.0',
    brandName: 'Symbiote',
    brandUrl: '',
  };
}

function createDefaultUiCopy(metadata: PackageMetadata): UiCopy {
  return {
    appName: metadata.appName,
    brandName: metadata.brandName,
    brandUrl: metadata.brandUrl,
    welcomeTitle: 'How can I help you today?',
    welcomeTemplate: "I'm {{agentName}}, your AI assistant powered by {{appName}}. Ask me anything.",
    emptySessionsLabel: 'No conversations yet',
    defaultSessionTitle: 'New conversation',
    sendPlaceholder: 'Send a message...',
    composerHint: 'Enter to send',
    composerHintSecondary: 'Shift+Enter for new line',
    suggestionPrompts: [
      'What can you help me with?',
      'Tell me about your capabilities',
      'What makes you different?',
      'Help me with research',
    ],
  };
}

function deriveProviderSummaries(loadedConfig: Partial<SymbioteConfigType>, activeProvider: string): ProviderSummary[] {
  const ids = new Set<string>();
  if (activeProvider) ids.add(activeProvider);
  if (loadedConfig.defaultProvider) ids.add(loadedConfig.defaultProvider);
  for (const providerId of Object.keys(loadedConfig.providers ?? {})) ids.add(providerId);
  for (const providerId of loadedConfig.fallbackProviders ?? []) ids.add(providerId);

  return Array.from(ids).map((id) => ({
    id,
    name: formatProviderLabel(id),
    active: id === activeProvider,
    configured: Boolean((loadedConfig.providers ?? {})[id]) || id === activeProvider,
  }));
}

function formatProviderLabel(providerId: string): string {
  const specialLabels: Record<string, string> = {
    'github-copilot': 'GitHub Copilot',
    xai: 'xAI',
  };
  if (specialLabels[providerId]) return specialLabels[providerId];
  return providerId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function applyRuntimeOptions(overrides: WebServerOptions): void {
  const mergedUi = {
    ...runtimeOptions.ui,
    ...overrides.ui,
  };

  runtimeOptions = {
    ...runtimeOptions,
    ...overrides,
    ui: mergedUi,
    providers: overrides.providers ?? runtimeOptions.providers,
    tools: overrides.tools ?? runtimeOptions.tools,
  };

  agentName = runtimeOptions.agentName || agentName;
  agentEmoji = runtimeOptions.agentEmoji || agentEmoji;
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

// ── Real chat streaming (proxies to the configured HTTP API) ────────────────

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
    const payload = JSON.stringify({ sessionId, message: userMessage, senderId: 'webchat-owner', source: 'webchat' });

    const apiRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const apiReq = http.request({
        hostname: runtimeOptions.apiHost,
        port: runtimeOptions.apiPort,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(runtimeOptions.apiKey ? { 'Authorization': `Bearer ${runtimeOptions.apiKey}` } : {}),
        },
        timeout: 300000, // 5 min timeout for long agent runs
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
            // We'll send our own done event below
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
      latencyMs: latency,
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

function renderWelcome(agent: string): string {
  return runtimeOptions.ui.welcomeTemplate
    .replaceAll('{{agentName}}', agent)
    .replaceAll('{{appName}}', runtimeOptions.ui.appName);
}

// ── Router ─────────────────────────────────────────────────────────────────

const WEB_DIR = path.resolve(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)), '../../web');

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
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
      version: runtimeOptions.version,
      agentName,
      agentEmoji,
      providerCount: runtimeOptions.providers.length,
      toolCount: runtimeOptions.tools.length,
    });
  }

  // GET /api/providers
  if (method === 'GET' && pathname === '/api/providers') {
    return json(res, runtimeOptions.providers);
  }

  // GET /api/tools
  if (method === 'GET' && pathname === '/api/tools') {
    return json(res, runtimeOptions.tools);
  }

  // GET /api/config
  if (method === 'GET' && pathname === '/api/config') {
    return json(res, {
      ...config,
      apiKeys: redactKeys(config.apiKeys),
      agentName,
      agentEmoji,
      version: runtimeOptions.version,
      ui: {
        ...runtimeOptions.ui,
        welcomeDescription: renderWelcome(agentName),
      },
      stats: {
        providerCount: runtimeOptions.providers.length,
        toolCount: runtimeOptions.tools.length,
        subAgentCount: subAgents.filter(agent => agent.status === 'running').length,
      },
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
        name: runtimeOptions.ui.defaultSessionTitle,
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
      return serveStatic(res, path.join(WEB_DIR, 'index.html'));
    }
    // Serve other static files
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    return serveStatic(res, path.join(WEB_DIR, safePath));
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

export function startWebServer(options?: number | WebServerOptions, host = '127.0.0.1'): http.Server {
  if (typeof options === 'number') {
    applyRuntimeOptions({ port: options, host });
  } else {
    applyRuntimeOptions(options ?? {});
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error(`${palette.dim}  [symbiote-web]${palette.reset}`, err);
      if (!res.headersSent) {
        json(res, { error: 'Internal server error' }, 500);
      }
    });
  });

  // Create a default session
  const defaultSession: Session = {
    id: uid(),
    name: runtimeOptions.ui.defaultSessionTitle,
    systemPrompt: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tokensUsed: 0,
  };
  sessions.set(defaultSession.id, defaultSession);

  server.listen(runtimeOptions.port, runtimeOptions.host, () => {
    console.log(ok(`Web UI → ${palette.cyan}http://${runtimeOptions.host}:${runtimeOptions.port}${palette.reset}`));
  });

  return server;
}

// Run directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  startWebServer({
    port: parseInt(process.env.MACH6_WEB_PORT ?? process.env.MACH6_PORT ?? '3009', 10),
    host: process.env.MACH6_WEB_HOST ?? '127.0.0.1',
    apiPort: parseInt(process.env.MACH6_API_PORT ?? process.env.MACH6_PORT ?? '3006', 10),
    apiHost: process.env.MACH6_API_HOST ?? '127.0.0.1',
    apiKey: process.env.MACH6_API_KEY ?? process.env.API_KEY ?? '',
  });
}
