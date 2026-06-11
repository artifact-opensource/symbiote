/**
 * Symbiote IPC Client
 * 
 * Helper for sending authenticated IPC requests to other Symbiote agents.
 * Signs requests with the local agent's HMAC-SHA256 key.
 * 
 * Usage:
 *   const client = new IpcClient();
 *   const response = await client.chat('aria', 'Hey Aria, here is the roster...');
 * 
 * @module ipc-client
 * @author AVA — Artifact Virtual
 * @created 2026-03-11
 */

import * as http from 'node:http';
import { IpcIdentity, type IpcKeyring } from './ipc-identity.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface IpcChatOptions {
  /** Session ID for conversation continuity */
  sessionId?: string;
  /** Source identifier */
  source?: string;
  /** Sender display name */
  senderName?: string;
  /** Request timeout in ms (default: 120000 — 2 minutes) */
  timeoutMs?: number;
}

export interface IpcChatResponse {
  text: string;
  sessionId: string;
  durationMs?: number;
  verifiedSender?: string;
}

// ── IPC Client ─────────────────────────────────────────────────────────────

export class IpcClient {
  private identity: IpcIdentity;
  private apiKey: string;

  /**
   * Create an IPC client.
   * 
   * @param keyringPath — Path to the keyring (defaults to IPC_KEYRING_PATH env var)
   * @param myAgentId — This agent's ID (defaults to IPC_AGENT_ID env var)
   * @param apiKey — The target's API key (for Bearer auth). Defaults to MACH6_API_KEY env.
   */
  constructor(keyringPath?: string, myAgentId?: string, apiKey?: string) {
    this.identity = new IpcIdentity(keyringPath, myAgentId);
    this.apiKey = apiKey ?? process.env.MACH6_API_KEY ?? process.env.API_KEY ?? '';
  }

  /**
   * Send an authenticated chat message to another agent.
   * 
   * @param targetAgentId — The agent to send to (must be in keyring with host/port)
   * @param text — The message text
   * @param options — Additional options
   */
  async chat(
    targetAgentId: string,
    text: string,
    options: IpcChatOptions = {}
  ): Promise<IpcChatResponse> {
    const agents = this.identity.listAgents();
    const target = agents.find(a => a.id === targetAgentId);
    if (!target) {
      throw new Error(`IPC Client: Unknown target agent '${targetAgentId}'`);
    }

    // Get target connection details from keyring
    // We need to re-read the keyring for host/port — the public API only exposes id/name/description
    // So we access the keyring directly via a fresh read
    const keyringPath = process.env.IPC_KEYRING_PATH ?? '/etc/mach6/ipc-keyring.json';
    const { readFileSync } = await import('node:fs');
    const keyring: IpcKeyring = JSON.parse(readFileSync(keyringPath, 'utf-8'));
    const targetAgent = keyring.agents[targetAgentId];

    if (!targetAgent) {
      throw new Error(`IPC Client: Target '${targetAgentId}' not in keyring`);
    }

    const host = targetAgent.host ?? '127.0.0.1';
    const port = targetAgent.port;

    if (!port) {
      throw new Error(`IPC Client: No port configured for agent '${targetAgentId}'`);
    }

    // Build request body
    const body = JSON.stringify({
      text,
      sessionId: options.sessionId ?? `ipc-${this.identity.getMyId()}-${targetAgentId}`,
      source: options.source ?? 'ipc',
      senderId: this.identity.getMyId(),
      senderName: options.senderName ?? this.identity.getMyId(),
    });

    // Sign the request
    const ipcHeaders = this.identity.sign(body);

    // Make the HTTP request
    const timeoutMs = options.timeoutMs ?? 120_000;

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: host,
          port,
          path: '/api/v1/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.apiKey}`,
            ...ipcHeaders,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString();
            try {
              const parsed = JSON.parse(responseBody);
              if (res.statusCode !== 200) {
                reject(new Error(`IPC request to ${targetAgentId} failed (${res.statusCode}): ${parsed.error ?? responseBody}`));
                return;
              }
              resolve({
                text: parsed.text,
                sessionId: parsed.sessionId,
                durationMs: parsed.durationMs,
                verifiedSender: targetAgentId,
              });
            } catch {
              reject(new Error(`IPC response from ${targetAgentId} is not valid JSON: ${responseBody.slice(0, 200)}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        reject(new Error(`IPC connection to ${targetAgentId} (${host}:${port}) failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`IPC request to ${targetAgentId} timed out after ${timeoutMs}ms`));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Check if a target agent is reachable (health endpoint).
   */
  async ping(targetAgentId: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const keyringPath = process.env.IPC_KEYRING_PATH ?? '/etc/mach6/ipc-keyring.json';
    const { readFileSync } = await import('node:fs');
    const keyring: IpcKeyring = JSON.parse(readFileSync(keyringPath, 'utf-8'));
    const targetAgent = keyring.agents[targetAgentId];

    if (!targetAgent?.port) {
      return { ok: false, latencyMs: 0, error: `No port for agent '${targetAgentId}'` };
    }

    const start = Date.now();
    const host = targetAgent.host ?? '127.0.0.1';

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: host,
          port: targetAgent.port,
          path: '/api/v1/health',
          method: 'GET',
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({
              ok: res.statusCode === 200,
              latencyMs: Date.now() - start,
            });
          });
        }
      );

      req.on('error', (err) => {
        resolve({ ok: false, latencyMs: Date.now() - start, error: err.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, latencyMs: Date.now() - start, error: 'timeout' });
      });
      req.end();
    });
  }
}
