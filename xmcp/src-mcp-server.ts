// Symbiote — MCP Server
// Exposes all Symbiote tools via MCP protocol (JSON-RPC over stdio)
// Connect from VS Code: add to .vscode/mcp.json or global mcp.json
//
// Usage:
//   node dist/tools/mcp-server.js [--config /path/to/symbiote.json]
//
// VS Code mcp.json:
//   {
//     "servers": {
//       "symbiote": {
//         "type": "stdio",
//         "command": "node",
//         "args": ["/path/to/symbiote/dist/tools/mcp-server.js"]
//       }
//     }
//   }

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolRegistry } from './registry.js';
import { readTool } from './builtin/read.js';
import { writeTool } from './builtin/write.js';
import { execTool } from './builtin/exec.js';
import { editTool } from './builtin/edit.js';
import { imageTool } from './builtin/image.js';
import { processStartTool, processPollTool, processKillTool, processListTool } from './builtin/process.js';
import { ttsTool } from './builtin/tts.js';
import { webFetchTool } from './builtin/web-fetch.js';
import { memorySearchTool } from './builtin/memory.js';
import { combRecallTool, combStageTool } from './builtin/comb.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Server State ───────────────────────────────────────────────────────────

const SERVER_NAME = 'symbiote';
const SERVER_VERSION = '1.3.0';
const PROTOCOL_VERSION = '3.05-03-26';

let initialized = false;
const registry = new ToolRegistry();

// Register all builtin tools
for (const tool of [
  readTool, writeTool, execTool, editTool, imageTool,
  processStartTool, processPollTool, processKillTool, processListTool,
  ttsTool, webFetchTool, memorySearchTool,
  combRecallTool, combStageTool,
]) {
  registry.register(tool);
}

// Set working directory from config
const configArg = process.argv.indexOf('--config');
const configPath = configArg >= 0 && process.argv[configArg + 1]
  ? process.argv[configArg + 1]
  : path.join(process.cwd(), 'symbiote.json');

try {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const workspace = raw.workspace ?? process.cwd();
  process.chdir(workspace);
  log(`Workspace: ${workspace}`);
} catch {
  log(`No config at ${configPath}, using cwd: ${process.cwd()}`);
}

// ── Logging (to stderr, stdout is for JSON-RPC) ───────────────────────────

function log(msg: string): void {
  process.stderr.write(`[mcp-server] ${msg}\n`);
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────

function sendResponse(id: number | string, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id: number | string | undefined, code: number, message: string, data?: unknown): void {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  });
  process.stdout.write(msg + '\n');
}

function sendNotification(method: string, params?: Record<string, unknown>): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  process.stdout.write(msg + '\n');
}

// ── Tool schema conversion ────────────────────────────────────────────────

function getToolSchemas(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return registry.list().map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.parameters.properties).map(([key, param]) => [
          key,
          {
            type: param.type,
            ...(param.description ? { description: param.description } : {}),
            ...(param.enum ? { enum: param.enum } : {}),
          },
        ])
      ),
      ...(tool.parameters.required?.length ? { required: tool.parameters.required } : {}),
    },
  }));
}

// ── Request handlers ──────────────────────────────────────────────────────

async function handleRequest(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg;

  // Notifications (no id) — handle silently
  if (id === undefined) {
    if (method === 'notifications/initialized') {
      log('Client initialized notification received');
    }
    return;
  }

  switch (method) {
    case 'initialize': {
      initialized = true;
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      log(`Initialized — protocol ${PROTOCOL_VERSION}`);
      break;
    }

    case 'tools/list': {
      if (!initialized) {
        sendError(id, -32002, 'Server not initialized');
        return;
      }
      const tools = getToolSchemas();
      sendResponse(id, { tools });
      log(`Listed ${tools.length} tools`);
      break;
    }

    case 'tools/call': {
      if (!initialized) {
        sendError(id, -32002, 'Server not initialized');
        return;
      }

      const toolName = (params as Record<string, unknown>)?.name as string;
      const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;

      if (!toolName) {
        sendError(id, -32602, 'Missing tool name');
        return;
      }

      const tool = registry.get(toolName);
      if (!tool) {
        sendError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }

      log(`Calling tool: ${toolName}`);
      try {
        const result = await tool.execute(toolArgs);
        sendResponse(id, {
          content: [{ type: 'text', text: result }],
          isError: false,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Tool error: ${toolName} — ${errMsg}`);
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: errMsg }) }],
          isError: true,
        });
      }
      break;
    }

    case 'ping': {
      sendResponse(id, {});
      break;
    }

    default: {
      sendError(id, -32601, `Method not found: ${method}`);
      break;
    }
  }
}

// ── Main loop (stdio JSON-RPC) ────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line: string) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as JsonRpcMessage;
    await handleRequest(msg);
  } catch (err) {
    log(`Parse error: ${err}`);
    sendError(undefined, -32700, 'Parse error');
  }
});

rl.on('close', () => {
  log('stdin closed — shutting down');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('SIGTERM — shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT — shutting down');
  process.exit(0);
});

log(`Symbiote MCP Server v${SERVER_VERSION} ready — ${registry.list().length} tools`);
