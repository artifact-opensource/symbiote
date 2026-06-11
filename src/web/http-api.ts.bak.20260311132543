/**
 * Mach6 — HTTP API Channel Adapter
 * 
 * Exposes a REST API for external clients (web apps, CLI tools, etc.) to
 * send messages and receive responses. Routes through the same
 * agent pipeline as Discord/WhatsApp.
 * 
 * Endpoints:
 *   POST /api/v1/chat   — send a message, get a response (SSE stream or JSON)
 *   GET  /api/v1/health  — gateway health
 *   POST /api/v1/relay   — relay to WhatsApp (Option C bridge)
 * 
 * Auth: Bearer token in Authorization header (API_KEY from env/config)
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { palette, ok, warn } from '../cli/brand.js';

const __http_dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────────────────────────────

export interface HttpApiConfig {
  port: number;
  apiKey: string;
  /** CORS origins to allow (default: ['*']) */
  allowedOrigins?: string[];
  /** Callback to handle a chat message through the agent pipeline */
  onChat: (message: ChatRequest) => Promise<ChatResponse>;
  /** Callback to relay a message to WhatsApp */
  onRelay?: (target: string, text: string) => Promise<{ success: boolean; error?: string }>;
  /** Get gateway status */
  onHealth?: () => Record<string, unknown>;
}

export interface ChatRequest {
  /** The text message from the user */
  text: string;
  /** Session identifier (for conversation continuity) */
  sessionId?: string;
  /** Sender identifier */
  senderId?: string;
  /** Sender display name */
  senderName?: string;
  /** Source identifier (e.g., "gladius-page") */
  source?: string;
}

export interface ChatResponse {
  text: string;
  sessionId: string;
  /** How long the agent took */
  durationMs?: number;
}

// ── Server ─────────────────────────────────────────────────────────────────

export class HttpApiServer {
  private server: http.Server | null = null;
  private config: HttpApiConfig;

  constructor(config: HttpApiConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          console.error(`${palette.dim}  [http-api]${palette.reset} ${palette.red}Unhandled error:${palette.reset}`, err);
          if (!res.headersSent) {
            this.json(res, { error: 'Internal server error' }, 500);
          }
        });
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.log(warn(`HTTP API port ${palette.white}${this.config.port}${palette.reset} in use — API disabled ${palette.dim}(non-fatal)${palette.reset}`));
          this.server = null;
          resolve(); // Don't crash the gateway over a port conflict
        } else {
          console.error(`  ${palette.red}✗${palette.reset} HTTP API error: ${err.message}`);
          this.server = null;
          resolve(); // Non-fatal — gateway continues without HTTP API
        }
      });
      this.server.listen(this.config.port, '0.0.0.0', () => {
        console.log(ok(`HTTP API → ${palette.cyan}http://0.0.0.0:${this.config.port}/api/v1/${palette.reset}`));
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  // ── Request Handler ──────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // CORS
    const origin = req.headers.origin ?? '*';
    const allowedOrigins = this.config.allowedOrigins ?? ['*'];
    const allowOrigin = allowedOrigins.includes('*') || allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0];

    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health (no auth required) — supports /api/v1/health, /api/status (web UI compat)
    if (method === 'GET' && (pathname === '/api/v1/health' || pathname === '/api/status')) {
      const health = this.config.onHealth?.() ?? { status: 'ok' };
      return this.json(res, health);
    }

    // Serve web UI at root (no auth — local only)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const webPaths = [
        path.join(__http_dirname, '..', '..', 'web', 'index.html'),
        path.join(__http_dirname, '..', 'web', 'index.html'),
        path.join(process.cwd(), 'web', 'index.html'),
      ];
      for (const webPath of webPaths) {
        try {
          const html = fs.readFileSync(webPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        } catch { /* try next */ }
      }
    }

    // Auth check — skip for web UI chat path (local-only, served from same origin)
    const isWebUIPath = pathname === '/api/chat';
    if (!isWebUIPath && !this.authenticate(req)) {
      return this.json(res, { error: 'Unauthorized' }, 401);
    }

    // POST /api/v1/chat (JSON response) + /api/chat (SSE response for web UI)
    if (method === 'POST' && (pathname === '/api/v1/chat' || pathname === '/api/chat')) {
      const isWebUI = pathname === '/api/chat';
      return this.handleChat(req, res, isWebUI);
    }

    // POST /api/v1/relay
    if (method === 'POST' && pathname === '/api/v1/relay') {
      return this.handleRelay(req, res);
    }

    // 404
    this.json(res, { error: 'Not found' }, 404);
  }

  // ── Chat Endpoint ────────────────────────────────────────────────────

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse, sse = false): Promise<void> {
    const body = await this.readBody(req);
    let parsed: ChatRequest;

    try {
      parsed = JSON.parse(body);
      // Accept both "text" and "message" fields (web UI sends "message")
      if (!parsed.text && (parsed as any).message) {
        parsed.text = (parsed as any).message;
      }
    } catch {
      return this.json(res, { error: 'Invalid JSON' }, 400);
    }

    if (!parsed.text || typeof parsed.text !== 'string' || !parsed.text.trim()) {
      return this.json(res, { error: 'text field is required' }, 400);
    }

    // Default session ID based on source
    if (!parsed.sessionId) {
      parsed.sessionId = `http-${parsed.source ?? 'web'}-${parsed.senderId ?? 'anon'}`;
    }

    console.log(`${palette.dim}  [http-api]${palette.reset} Chat: "${parsed.text.slice(0, 80)}..." ${palette.dim}(session=${parsed.sessionId})${palette.reset}`);

    try {
      const startMs = Date.now();
      const response = await this.config.onChat(parsed);
      response.durationMs = Date.now() - startMs;

      if (sse) {
        // SSE format for web UI
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'text', content: response.text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', message: { latencyMs: response.durationMs } })}\n\n`);
        res.end();
      } else {
        // JSON format for API clients
        this.json(res, {
          text: response.text,
          sessionId: response.sessionId,
          durationMs: response.durationMs,
        });
      }
    } catch (err) {
      console.error(`${palette.dim}  [http-api]${palette.reset} ${palette.red}Chat error:${palette.reset}`, err);
      this.json(res, {
        error: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  }

  // ── Relay Endpoint (WhatsApp bridge) ─────────────────────────────────

  private async handleRelay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.config.onRelay) {
      return this.json(res, { error: 'Relay not configured' }, 501);
    }

    const body = await this.readBody(req);
    let parsed: { target?: string; text?: string };

    try {
      parsed = JSON.parse(body);
    } catch {
      return this.json(res, { error: 'Invalid JSON' }, 400);
    }

    if (!parsed.text || !parsed.target) {
      return this.json(res, { error: 'target and text fields are required' }, 400);
    }

    console.log(`${palette.dim}  [http-api]${palette.reset} Relay to ${palette.cyan}${parsed.target}${palette.reset}: "${parsed.text.slice(0, 80)}..."`);

    try {
      const result = await this.config.onRelay(parsed.target, parsed.text);
      this.json(res, result);
    } catch (err) {
      console.error(`${palette.dim}  [http-api]${palette.reset} ${palette.red}Relay error:${palette.reset}`, err);
      this.json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private authenticate(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth) return false;

    // Bearer token
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;

    // Constant-time comparison
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(this.config.apiKey);
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
  }

  private json(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_SIZE = 1024 * 1024; // 1MB

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_SIZE) {
          req.destroy();
          reject(new Error('Body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }
}
