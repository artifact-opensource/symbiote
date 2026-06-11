// Symbiote — MCP Client Bridge
// Connects to AVA Gateway (or any MCP server) via stdio, discovers tools,
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
  inputSchema?: {
    type: string;
    properties?: Record<string, { type?: string; description?: string; enum?: string[]; default?: unknown }>;
    required?: string[];
  };
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
      clientInfo: { name: 'symbiote', version: '1.0.0' },
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
      properties[key] = {
        type: val.type ?? 'string',
        description: val.description,
        ...(val.enum ? { enum: val.enum } : {}),
      };
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
