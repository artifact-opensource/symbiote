// Symbiote â€” MCP Server
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
import { ingestWorkspaceSessions, vdbSearchTool, vdbIngestTool, vdbStatsTool } from './builtin/memory-vdb.js';
import { cuaTools } from './builtin/web-browser.js';
import { combRecallTool, combStageTool, setCombVdbHook } from './builtin/comb.js';
import { getSharedVectorDB } from '../memory/vdb.js';
import { importMemoGraphSnapshots, resolveMemoGraphStorageDir } from '../memory/memograph.js';
import { importSkillFiles, resolveSkillsDir } from '../memory/skills.js';
import { personaDigestTool } from './builtin/consolidate.js';
import { APP_VERSION } from '../meta/version.js';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// â”€â”€ Server State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SERVER_NAME = 'symbiote';
const SERVER_VERSION = APP_VERSION;
const PROTOCOL_VERSION = '2025-03-26';

let initialized = false;
const registry = new ToolRegistry();

// Register all builtin tools
for (const tool of [
  readTool, writeTool, execTool, editTool, imageTool,
  processStartTool, processPollTool, processKillTool, processListTool,
  ttsTool, webFetchTool, memorySearchTool, vdbSearchTool, vdbIngestTool, vdbStatsTool,
  combRecallTool, combStageTool, ...cuaTools, personaDigestTool,
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

const workspace = process.env.SYMBIOTE_WORKSPACE ?? process.cwd();
process.env.SYMBIOTE_WORKSPACE = workspace;
const workspaceVdb = getSharedVectorDB(workspace);
setCombVdbHook(
  (text, source) => {
    workspaceVdb.index({ id: '', text, source, role: 'context', timestamp: Date.now(), sessionId: 'mcp' });
  },
  (source, count) => workspaceVdb.recent(source, count),
);
try {
  const sessions = ingestWorkspaceSessions();
  const memograph = importMemoGraphSnapshots(workspaceVdb, resolveMemoGraphStorageDir(workspace));
  const skills = importSkillFiles(workspaceVdb, resolveSkillsDir(workspace));
  if (sessions.indexed > 0 || memograph.indexed > 0 || skills.indexed > 0) {
    log(`Indexed ${sessions.indexed} sessions, ${memograph.indexed} Memograph shards, ${skills.indexed} skill files`);
  }
} catch (error) {
  log(`VDB bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
}

// â”€â”€ Logging (to stderr, stdout is for JSON-RPC) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function log(msg: string): void {
  process.stderr.write(`[mcp-server] ${msg}\n`);
}

// â”€â”€ JSON-RPC helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Tool schema conversion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Request handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleRequest(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg;

  // Notifications (no id) â€” handle silently
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
      log(`Initialized â€” protocol ${PROTOCOL_VERSION}`);
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
        log(`Tool error: ${toolName} â€” ${errMsg}`);
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

// â”€â”€ Main loop (stdio JSON-RPC) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  log('stdin closed â€” shutting down');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('SIGTERM â€” shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT â€” shutting down');
  process.exit(0);
});

log(`Symbiote MCP Server v${SERVER_VERSION} ready â€” ${registry.list().length} tools`);
