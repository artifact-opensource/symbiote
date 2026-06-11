/**
 * Symbiote — Abstract Channel Adapter Base
 * 
 * Provides common infrastructure (health tracking, reconnection logic,
 * rate limiting) so concrete adapters only implement platform-specific I/O.
 */

import { randomUUID } from 'node:crypto';
import type {
  BusEnvelope,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfig,
  ChannelSource,
  InboundPayload,
  AdapterHealth,
  OutboundMessage,
  SendResult,
} from './types.js';
import { HealthTracker } from './types.js';

// ─── Rate Limiter ──────────────────────────────────────────────────────────

export class TokenBucketLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(maxPerSecond: number, burstSize?: number) {
    this.maxTokens = burstSize ?? maxPerSecond;
    this.tokens = this.maxTokens;
    this.refillRate = maxPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  /** Returns delay in ms before send is allowed. 0 = immediate. */
  check(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ─── Abstract Base ─────────────────────────────────────────────────────────

export abstract class BaseAdapter implements ChannelAdapter {
  abstract readonly id: string;
  abstract readonly channelType: string;
  abstract readonly capabilities: ChannelCapabilities;

  protected health = new HealthTracker();
  protected rateLimiter?: TokenBucketLimiter;
  protected messageHandler?: (envelope: BusEnvelope) => void;
  protected abortController?: AbortController;
  protected reconnectAttempts = 0;
  protected maxReconnectAttempts = 10;
  protected reconnectBackoffMs = 1000;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async connect(config: ChannelConfig, signal?: AbortSignal): Promise<void> {
    this.abortController = new AbortController();

    // Setup rate limiter from capabilities
    const rl = this.capabilities.rateLimits;
    if (rl.messagesPerSecond) {
      this.rateLimiter = new TokenBucketLimiter(rl.messagesPerSecond, rl.burstSize);
    }

    // Forward external abort signal
    if (signal) {
      signal.addEventListener('abort', () => this.abortController?.abort(), { once: true });
    }

    try {
      await this.platformConnect(config);
      this.health.transition('connected');
      this.reconnectAttempts = 0;
    } catch (err) {
      this.health.transition('disconnected', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    try {
      await this.platformDisconnect();
    } finally {
      this.health.transition('disconnected');
    }
  }

  async reconnect(): Promise<void> {
    if (this.health.state === 'reconnecting') return; // Already reconnecting
    this.health.transition('disconnected');
    this.health.transition('reconnecting');

    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(
        this.reconnectBackoffMs * Math.pow(2, this.reconnectAttempts - 1),
        60_000, // Max 60s backoff
      );

      await sleep(delay);

      try {
        await this.platformReconnect();
        this.health.transition('connected');
        this.reconnectAttempts = 0;
        return;
      } catch (err) {
        console.error(`[${this.id}] Reconnect attempt ${this.reconnectAttempts} failed:`, err);
      }
    }

    this.health.transition('disconnected', `Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`);
  }

  getHealth(): AdapterHealth {
    return this.health.status;
  }

  onMessage(handler: (envelope: BusEnvelope) => void): void {
    this.messageHandler = handler;
  }

  onHealthChange(handler: (health: AdapterHealth) => void): void {
    this.health.onChange(handler);
  }

  // ── Outbound ───────────────────────────────────────────────────────────

  async send(chatId: string, message: OutboundMessage): Promise<SendResult> {
    // Rate limit check
    if (this.rateLimiter) {
      const delay = this.rateLimiter.check();
      if (delay > 0) await sleep(delay);
      this.rateLimiter.consume();
    }

    try {
      return await this.platformSend(chatId, message);
    } catch (err) {
      // Check if it's a connection issue
      if (this.isConnectionError(err)) {
        this.health.transition('degraded');
        // Queue for retry? For now, return error.
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Helpers for subclasses ─────────────────────────────────────────────

  /**
   * Emit a normalized inbound message to the bus via the registered handler.
   * Call this from platform event handlers.
   */
  protected emit(source: ChannelSource, payload: InboundPayload, platformMessageId?: string): void {
    if (!this.messageHandler) return;

    const envelope: BusEnvelope = {
      id: randomUUID(),
      timestamp: Date.now(),
      priority: 'normal', // Router will reassign priority
      source,
      payload,
      metadata: { platformMessageId },
    };

    this.messageHandler(envelope);
  }

  protected isConnectionError(_err: unknown): boolean {
    // Subclasses can override with platform-specific checks
    return false;
  }

  // ── Abstract: Platform-specific implementation ─────────────────────────

  /** Connect to the platform */
  protected abstract platformConnect(config: ChannelConfig): Promise<void>;
  /** Disconnect from the platform */
  protected abstract platformDisconnect(): Promise<void>;
  /** Reconnect to the platform */
  protected abstract platformReconnect(): Promise<void>;
  /** Send a message on the platform */
  protected abstract platformSend(chatId: string, message: OutboundMessage): Promise<SendResult>;
}

// ─── Utility ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
