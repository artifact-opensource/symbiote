// Symbiote — MCP Client Bridge
// Connects to a Symbiote gateway (or any MCP server) via stdio, discovers tools,
// and registers them as native Symbiote tools.
//
// Usage:
//   import { McpBridge } from './mcp-bridge.js';
//   const bridge = new McpBridge({ command: ['python3', '/path/to/gateway.py'] });
//   await bridge.connect();
//   for (const tool of bridge.getTools()) registry.register(tool);

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { ToolDefinition, ToolParameter } from './types.js';
import { APP_VERSION } from '../meta/version.js';

interface McpBridgeConfig {
  /** Command + args to spawn the MCP server */
  command: string[];
  /** Working directory for the child process */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Connection timeout in ms (default: 30000) */
  timeout?: number;
  /** Name prefix for tools (e.g. "gw_" — empty by default) */
  toolPrefix?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: McpJsonSchema;
}

interface McpJsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  required?: string[];
  properties?: Record<string, McpJsonSchema>;
  items?: McpJsonSchema;
  additionalProperties?: boolean | McpJsonSchema;
}

function toToolParameter(schema: McpJsonSchema): ToolParameter {
  return {
    type: schema.type ?? 'string',
    ...(schema.description ? { description: schema.description } : {}),
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.required ? { required: schema.required } : {}),
    ...(schema.properties ? {
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [key, toToolParameter(value)]),
      ),
    } : {}),
    ...(schema.items ? { items: toToolParameter(schema.items) } : {}),
    ...(schema.additionalProperties !== undefined ? {
      additionalProperties: typeof schema.additionalProperties === 'boolean'
        ? schema.additionalProperties
        : toToolParameter(schema.additionalProperties),
    } : {}),
  };
}

function parseMcpResponse(text: string, requestId: number): JsonRpcResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const events = trimmed.split(/\r?\n\r?\n/);
  const candidates = events.flatMap(event => {
    const dataLines = event.split(/\r?\n/).filter(line => line.startsWith('data:'));
    return dataLines.length > 0
      ? [dataLines.map(line => line.slice(5).trimStart()).join('\n')]
      : [];
  });
  if (candidates.length === 0) candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      const message = JSON.parse(candidate) as JsonRpcResponse;
      if (message.id === requestId) return message;
    } catch {
      continue;
    }
  }
  return undefined;
}

export class McpBridge {
  private config: McpBridgeConfig;
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private serverInfo: { name?: string; version?: string } = {};
  private discoveredTools: McpToolSchema[] = [];
  private connected = false;

  constructor(config: McpBridgeConfig) {
    this.config = config;
  }

  /** Spawn the child process and perform MCP handshake + tool discovery */
  async connect(): Promise<void> {
    const timeout = this.config.timeout ?? 30000;

    // Spawn child
    const env = { ...process.env, ...(this.config.env ?? {}) };
    this.process = spawn(this.config.command[0], this.config.command.slice(1), {
      cwd: this.config.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // Pipe stderr to our stderr for debugging
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[mcp-bridge] ${text}`);
    });

    // Line-based JSON-RPC over stdout
    this.readline = createInterface({ input: this.process.stdout! });
    this.readline.on('line', (line: string) => this._handleLine(line));

    // Handle process exit
    this.process.on('exit', (code) => {
      console.warn(`[mcp-bridge] Child process exited with code ${code}`);
      this.connected = false;
      // Reject all pending requests
      for (const [id, p] of this.pending) {
        p.reject(new Error(`MCP server exited (code ${code})`));
        clearTimeout(p.timer);
      }
      this.pending.clear();
    });

    // Wait a moment for the server to start
    await new Promise(r => setTimeout(r, 500));

    // Initialize handshake
    const initResp = await this._request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'symbiote', version: APP_VERSION },
    }, timeout);

    if (initResp.error) {
      throw new Error(`MCP initialize failed: ${initResp.error.message}`);
    }

    const result = initResp.result as Record<string, unknown>;
    this.serverInfo = (result.serverInfo as { name?: string; version?: string }) ?? {};

    // Send initialized notification
    this._notify('notifications/initialized');

    // Wait for server to finish startup (spawning child servers)
    await new Promise(r => setTimeout(r, 3000));

    // Discover tools
    const capabilities = (result.capabilities as Record<string, unknown>) ?? {};
    if (capabilities.tools !== undefined) {
      const toolResp = await this._request('tools/list', {}, timeout);
      if (!toolResp.error) {
        this.discoveredTools = ((toolResp.result as Record<string, unknown>).tools as McpToolSchema[]) ?? [];
      }
    }

    this.connected = true;
    console.log(
      `[mcp-bridge] Connected to ${this.serverInfo.name ?? 'unknown'} v${this.serverInfo.version ?? '?'} — ` +
      `${this.discoveredTools.length} tools discovered`
    );
  }

  /** Get all discovered tools as Symbiote ToolDefinitions */
  getTools(): ToolDefinition[] {
    const prefix = this.config.toolPrefix ?? '';
    return this.discoveredTools
      .filter(t => !t.name.startsWith('gateway_'))  // Skip gateway management tools
      .map(t => this._wrapTool(t, prefix));
  }

  /** Get gateway management tools separately */
  getManagementTools(): ToolDefinition[] {
    const prefix = this.config.toolPrefix ?? '';
    return this.discoveredTools
      .filter(t => t.name.startsWith('gateway_'))
      .map(t => this._wrapTool(t, prefix));
  }

  /** Call a tool on the remote MCP server */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.connected || !this.process) {
      return JSON.stringify({ error: 'MCP bridge not connected' });
    }

    try {
      const resp = await this._request('tools/call', {
        name,
        arguments: args,
      }, 60000); // 60s timeout for tool calls

      if (resp.error) {
        return JSON.stringify({ error: resp.error.message });
      }

      const result = resp.result as Record<string, unknown>;
      const content = result.content as Array<{ type: string; text?: string }>;
      if (content?.[0]?.text) {
        return content[0].text;
      }
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Disconnect and kill the child process */
  disconnect(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
    this.connected = false;
    this.readline?.close();
  }

  /** Check if the bridge is connected */
  isConnected(): boolean {
    return this.connected && this.process !== null && this.process.exitCode === null;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _wrapTool(schema: McpToolSchema, prefix: string): ToolDefinition {
    const toolName = prefix + schema.name;
    const bridge = this; // capture for closure

    // Convert MCP input schema to Symbiote parameter format
    const inputSchema = schema.inputSchema ?? { type: 'object', properties: {}, required: [] };
    const properties: Record<string, ToolParameter> = {};
    for (const [key, val] of Object.entries(inputSchema.properties ?? {})) {
      properties[key] = toToolParameter(val);
    }

    return {
      name: toolName,
      description: schema.description ?? `MCP tool: ${schema.name}`,
      parameters: {
        type: 'object',
        properties,
        required: inputSchema.required,
      },
      async execute(input: Record<string, unknown>): Promise<string> {
        return bridge.callTool(schema.name, input);
      },
    };
  }

  private _handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    } catch {
      // Non-JSON output — ignore (or log)
    }
  }

  private _request(method: string, params: Record<string, unknown>, timeoutMs: number = 30000): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.process!.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  private _notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcRequest = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    this.process?.stdin?.write(JSON.stringify(msg) + '\n');
  }
}

export interface HttpMcpBridgeConfig {
  url: string;
  token: string;
  timeout?: number;
  toolPrefix?: string;
  fetcher?: typeof fetch;
}

/** MCP Streamable HTTP client for remote servers that use bearer-token auth. */
export class HttpMcpBridge {
  private readonly config: HttpMcpBridgeConfig;
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private requestId = 0;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private serverInfo: { name?: string; version?: string } = {};
  private discoveredTools: McpToolSchema[] = [];
  private connected = false;

  constructor(config: HttpMcpBridgeConfig) {
    this.config = config;
    this.fetcher = config.fetcher ?? fetch;
    this.endpoint = this.validateEndpoint(config.url);
    if (!config.token.trim()) throw new Error('MCP bearer token cannot be empty.');
  }

  async connect(): Promise<void> {
    const timeout = this.config.timeout ?? 30_000;
    const initialized = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'symbiote', version: APP_VERSION },
    }, timeout);
    const result = initialized.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== 'object') throw new Error('MCP initialize returned an invalid response.');
    if (typeof result.protocolVersion !== 'string') {
      throw new Error('MCP initialize did not negotiate a protocol version.');
    }
    this.protocolVersion = result.protocolVersion;
    this.serverInfo = (result.serverInfo as { name?: string; version?: string } | undefined) ?? {};
    if (!result.capabilities || typeof result.capabilities !== 'object'
      || !('tools' in result.capabilities)) {
      throw new Error('MCP server does not advertise tool support.');
    }

    await this.notify('notifications/initialized');
    const discovered: McpToolSchema[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await this.request('tools/list', cursor ? { cursor } : {}, timeout);
      const listResult = listed.result as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!listResult || !Array.isArray(listResult.tools)) {
        throw new Error('MCP tools/list returned an invalid response.');
      }
      discovered.push(...listResult.tools.filter((tool): tool is McpToolSchema =>
        Boolean(tool) && typeof tool === 'object'
        && typeof (tool as McpToolSchema).name === 'string'
        && (tool as McpToolSchema).name.length > 0,
      ));
      if (typeof listResult.nextCursor !== 'string' || !listResult.nextCursor) {
        cursor = undefined;
      } else if (cursors.has(listResult.nextCursor) || cursors.size >= 99) {
        throw new Error('MCP tools/list returned an invalid or excessive pagination cursor.');
      } else {
        cursor = listResult.nextCursor;
        cursors.add(cursor);
      }
    } while (cursor);
    this.discoveredTools = discovered;
    this.connected = true;
    console.log(
      `[mcp-bridge] Connected to ${this.serverInfo.name ?? 'remote server'}`
      + `${this.serverInfo.version ? ` v${this.serverInfo.version}` : ''} — `
      + `${this.discoveredTools.length} tools discovered`,
    );
  }

  getTools(): ToolDefinition[] {
    const prefix = this.config.toolPrefix ?? '';
    return this.discoveredTools.map(schema => this.wrapTool(schema, prefix));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.connected) return JSON.stringify({ error: 'MCP bridge not connected' });
    try {
      const response = await this.request('tools/call', { name, arguments: args }, 60_000);
      const result = response.result as {
        content?: Array<{ type?: string; text?: string }>;
      } | undefined;
      if (!result) return JSON.stringify({ error: 'MCP tools/call returned an invalid response.' });
      const text = result.content?.flatMap(item =>
        item.type === 'text' && typeof item.text === 'string' ? [item.text] : [],
      );
      return text?.length ? text.join('\n') : JSON.stringify(result);
    } catch (failure) {
      return JSON.stringify({ error: failure instanceof Error ? failure.message : String(failure) });
    }
  }

  disconnect(): void {
    this.connected = false;
    this.sessionId = undefined;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private wrapTool(schema: McpToolSchema, prefix: string): ToolDefinition {
    const bridge = this;
    const properties = Object.fromEntries(
      Object.entries(schema.inputSchema?.properties ?? {}).map(([key, value]) => [key, toToolParameter(value)]),
    );
    return {
      name: `${prefix}${schema.name}`,
      description: schema.description ?? `MCP tool: ${schema.name}`,
      parameters: {
        type: 'object',
        properties,
        ...(schema.inputSchema?.required ? { required: schema.inputSchema.required } : {}),
      },
      async execute(input): Promise<string> {
        return bridge.callTool(schema.name, input);
      },
    };
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    const id = ++this.requestId;
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`MCP server authorization failed (HTTP ${response.status}). Check the n8n MCP access token.`);
      }
      throw new Error(`MCP ${method} request failed (HTTP ${response.status}).`);
    }
    const message = parseMcpResponse(text, id);
    if (!message) throw new Error(`MCP ${method} returned no matching JSON-RPC response.`);
    if (message.error) throw new Error(`MCP ${method} failed: ${message.error.message}`);
    return message;
  }

  private async notify(method: string): Promise<void> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
    });
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    if (!response.ok) throw new Error(`MCP ${method} notification failed (HTTP ${response.status}).`);
    await response.body?.cancel();
  }

  private headers(): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    });
    if (this.sessionId) headers.set('mcp-session-id', this.sessionId);
    if (this.protocolVersion) headers.set('MCP-Protocol-Version', this.protocolVersion);
    return headers;
  }

  private validateEndpoint(value: string): URL {
    let endpoint: URL;
    try {
      endpoint = new URL(value);
    } catch (failure) {
      throw new Error('MCP endpoint must be an absolute HTTP(S) URL.', { cause: failure });
    }
    const hostname = endpoint.hostname.toLowerCase();
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLoopback))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/mcp-server/http') {
      throw new Error('MCP endpoint must be HTTPS (or loopback HTTP), end in /mcp-server/http, and contain no credentials, query, or fragment.');
    }
    return endpoint;
  }
}
