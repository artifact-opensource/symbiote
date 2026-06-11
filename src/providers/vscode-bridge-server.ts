#!/usr/bin/env node
// VS Code Copilot Bridge Server
// Runs as a local HTTP server that proxies chat requests through VS Code's Copilot
// Usage: node vscode-bridge-server.ts [port]

import * as http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = parseInt(process.argv[2] || '3033', 10);

interface ChatRequest {
  messages: { role: string; content: string }[];
  maxTokens?: number;
}

interface ChatResponse {
  message: string;
  usage?: { inputTokens: number; outputTokens: number };
}

const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (req.url !== '/chat') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    // Collect the request body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const chatReq: ChatRequest = JSON.parse(body);
        const response = await handleChatRequest(chatReq);
        
        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
    });
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: (error as Error).message }));
  }
});

async function handleChatRequest(req: ChatRequest): Promise<ChatResponse> {
  // Extract the user's latest message
  const lastMsg = req.messages.reverse().find((m) => m.role === 'user');
  if (!lastMsg) throw new Error('No user message found');

  const prompt = lastMsg.content;

  return new Promise((resolve, reject) => {
    // Set PATH to include local npm installation
    const localBin = `${process.env.HOME}/.npm-global/bin`;
    const env = {
      ...process.env,
      PATH: `${localBin}:${process.env.PATH}`,
    };

    // Use 'copilot' directly with -p (prompt) flag for non-interactive mode
    const proc = spawn('copilot', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code: number) => {
      // Use stdout, fall back to stderr if needed
      let response = stdout.trim() || stderr.trim();

      // Remove error messages and noise
      response = response
        .replace(/error: Invalid command format.*\n/gs, '')
        .replace(/Did you mean:.*\n/g, '')
        .replace(/For non-interactive mode.*\n/g, '')
        .replace(/Try 'copilot --help'.*\n/g, '')
        .trim();

      if (response.length > 0) {
        resolve({
          message: response,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      } else {
        reject(new Error('Empty response from Copilot'));
      }
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`Copilot error: ${err.message}`));
    });
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[vscode-bridge] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[vscode-bridge] POST /chat to route through Copilot`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[vscode-bridge] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[vscode-bridge] SIGINT received, shutting down');
  server.close(() => process.exit(0));
});

export default server;
