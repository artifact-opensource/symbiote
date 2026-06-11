/**
 * Symbiote IPC Identity Module
 * 
 * Cryptographic identity verification for inter-agent communication.
 * Uses HMAC-SHA256 with a shared keyring to verify agent identity
 * on incoming HTTP requests.
 * 
 * Protocol:
 *   Sender includes three headers:
 *     x-ipc-agent-id:   claimed agent identifier
 *     x-ipc-timestamp:  millisecond Unix timestamp
 *     x-ipc-signature:  HMAC-SHA256(timestamp + "." + body, agent_key) as hex
 * 
 *   Receiver verifies:
 *     1. Agent ID exists in keyring
 *     2. Timestamp within replay window (default 30s)
 *     3. Signature matches (constant-time comparison)
 * 
 * Non-IPC requests (no x-ipc-agent-id header) pass through unaffected.
 * 
 * @module ipc-identity
 * @author AVA — Artifact Virtual
 * @created 2026-03-11
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface IpcAgent {
  name: string;
  key: string;
  port?: number;
  host?: string;
  description?: string;
}

export interface IpcKeyring {
  version: number;
  description?: string;
  replayWindowMs?: number;
  agents: Record<string, IpcAgent>;
}

export interface IpcVerification {
  /** Whether IPC headers were present at all */
  isIpcRequest: boolean;
  /** Whether the signature was valid (only meaningful if isIpcRequest) */
  verified: boolean;
  /** The verified agent ID (only set if verified === true) */
  agentId?: string;
  /** The verified agent name (only set if verified === true) */
  agentName?: string;
  /** Error message if verification failed */
  error?: string;
}

export interface IpcSignatureHeaders {
  'x-ipc-agent-id': string;
  'x-ipc-timestamp': string;
  'x-ipc-signature': string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HEADER_AGENT_ID = 'x-ipc-agent-id';
const HEADER_TIMESTAMP = 'x-ipc-timestamp';
const HEADER_SIGNATURE = 'x-ipc-signature';

const DEFAULT_REPLAY_WINDOW_MS = 30_000; // 30 seconds
const DEFAULT_KEYRING_PATH = '/etc/mach6/ipc-keyring.json';

// ── IPC Identity Manager ───────────────────────────────────────────────────

export class IpcIdentity {
  private keyring: IpcKeyring;
  private replayWindowMs: number;
  private myAgentId: string | null;

  /**
   * Create a new IPC Identity manager.
   * 
   * @param keyringPath — Path to the JSON keyring file
   * @param myAgentId — This agent's own ID (for signing outgoing requests)
   */
  constructor(keyringPath?: string, myAgentId?: string) {
    const resolvedPath = keyringPath
      ?? process.env.IPC_KEYRING_PATH
      ?? DEFAULT_KEYRING_PATH;

    this.myAgentId = myAgentId ?? process.env.IPC_AGENT_ID ?? null;

    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      this.keyring = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `IPC Identity: Failed to load keyring from ${resolvedPath}: ${err instanceof Error ? err.message : err}`
      );
    }

    this.replayWindowMs = this.keyring.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;

    // Validate keyring
    if (!this.keyring.agents || typeof this.keyring.agents !== 'object') {
      throw new Error('IPC Identity: Keyring has no agents');
    }

    const agentCount = Object.keys(this.keyring.agents).length;
    if (agentCount === 0) {
      throw new Error('IPC Identity: Keyring is empty');
    }

    // Validate all keys are 64-char hex (256-bit)
    for (const [id, agent] of Object.entries(this.keyring.agents)) {
      if (!agent.key || !/^[0-9a-f]{64}$/i.test(agent.key)) {
        throw new Error(`IPC Identity: Invalid key for agent '${id}' — must be 64-char hex`);
      }
    }
  }

  /**
   * Verify an incoming IPC request.
   * 
   * Call this with the request headers and the raw request body (as string).
   * Returns an IpcVerification result.
   * 
   * If no IPC headers are present, returns { isIpcRequest: false, verified: false }
   * — this is NOT an error. The caller should treat it as a normal (non-IPC) request.
   */
  verify(headers: Record<string, string | string[] | undefined>, body: string): IpcVerification {
    const agentId = this.getHeader(headers, HEADER_AGENT_ID);

    // No IPC headers = not an IPC request. Pass through.
    if (!agentId) {
      return { isIpcRequest: false, verified: false };
    }

    const timestamp = this.getHeader(headers, HEADER_TIMESTAMP);
    const signature = this.getHeader(headers, HEADER_SIGNATURE);

    // Partial IPC headers = malformed request
    if (!timestamp || !signature) {
      return {
        isIpcRequest: true,
        verified: false,
        error: 'Missing required IPC headers (need x-ipc-agent-id, x-ipc-timestamp, x-ipc-signature)',
      };
    }

    // Look up agent in keyring
    const agent = this.keyring.agents[agentId];
    if (!agent) {
      return {
        isIpcRequest: true,
        verified: false,
        error: `Unknown agent: '${agentId}'`,
      };
    }

    // Verify timestamp (replay protection)
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      return {
        isIpcRequest: true,
        verified: false,
        error: 'Invalid timestamp',
      };
    }

    const now = Date.now();
    const drift = Math.abs(now - ts);
    if (drift > this.replayWindowMs) {
      return {
        isIpcRequest: true,
        verified: false,
        error: `Timestamp too far from now (drift=${drift}ms, window=${this.replayWindowMs}ms)`,
      };
    }

    // Verify signature: HMAC-SHA256(timestamp + "." + body, key)
    const signingPayload = `${timestamp}.${body}`;
    const expectedSig = crypto
      .createHmac('sha256', Buffer.from(agent.key, 'hex'))
      .update(signingPayload)
      .digest('hex');

    // Constant-time comparison
    const providedBuf = Buffer.from(signature, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');

    if (providedBuf.length !== expectedBuf.length) {
      return {
        isIpcRequest: true,
        verified: false,
        error: 'Signature length mismatch',
      };
    }

    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return {
        isIpcRequest: true,
        verified: false,
        error: 'Signature verification failed',
      };
    }

    // ✅ Verified
    return {
      isIpcRequest: true,
      verified: true,
      agentId,
      agentName: agent.name,
    };
  }

  /**
   * Sign an outgoing request body for IPC communication.
   * 
   * Returns the three headers that should be added to the request.
   * Uses this agent's own key (set via constructor or IPC_AGENT_ID env var).
   * 
   * @param body — The request body as a string (must match exactly what the receiver reads)
   * @param agentId — Override the sending agent ID (defaults to this.myAgentId)
   */
  sign(body: string, agentId?: string): IpcSignatureHeaders {
    const id = agentId ?? this.myAgentId;
    if (!id) {
      throw new Error('IPC Identity: No agent ID configured (set IPC_AGENT_ID env var or pass to constructor)');
    }

    const agent = this.keyring.agents[id];
    if (!agent) {
      throw new Error(`IPC Identity: Agent '${id}' not found in keyring`);
    }

    const timestamp = Date.now().toString();
    const signingPayload = `${timestamp}.${body}`;
    const signature = crypto
      .createHmac('sha256', Buffer.from(agent.key, 'hex'))
      .update(signingPayload)
      .digest('hex');

    return {
      'x-ipc-agent-id': id,
      'x-ipc-timestamp': timestamp,
      'x-ipc-signature': signature,
    };
  }

  /**
   * Get the list of known agents (for logging/status).
   */
  listAgents(): Array<{ id: string; name: string; description?: string }> {
    return Object.entries(this.keyring.agents).map(([id, agent]) => ({
      id,
      name: agent.name,
      description: agent.description,
    }));
  }

  /**
   * Check if this manager has a signing identity configured.
   */
  canSign(): boolean {
    return !!this.myAgentId && !!this.keyring.agents[this.myAgentId];
  }

  /**
   * Get the current agent's ID.
   */
  getMyId(): string | null {
    return this.myAgentId;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string
  ): string | undefined {
    const val = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  }
}

// ── Singleton (lazy) ───────────────────────────────────────────────────────

let _instance: IpcIdentity | null = null;

/**
 * Get or create the singleton IPC Identity manager.
 * Returns null if the keyring file doesn't exist (IPC disabled gracefully).
 */
export function getIpcIdentity(): IpcIdentity | null {
  if (_instance) return _instance;

  const keyringPath = process.env.IPC_KEYRING_PATH ?? DEFAULT_KEYRING_PATH;

  // Graceful: if no keyring exists, IPC is simply not configured
  if (!fs.existsSync(keyringPath)) {
    return null;
  }

  try {
    _instance = new IpcIdentity(keyringPath);
    return _instance;
  } catch (err) {
    console.error(`[ipc-identity] Failed to initialize: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Reset the singleton (for testing).
 */
export function resetIpcIdentity(): void {
  _instance = null;
}
