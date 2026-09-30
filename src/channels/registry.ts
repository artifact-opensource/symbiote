/**
 * Symbiote — Channel Registry
 * 
 * Manages channel adapter lifecycle. Hot-plug adapters without restart.
 * Wires adapters → router → bus → agent.
 */

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelPolicy,
  AdapterHealth,
} from './types.js';
import { SymbioteBus } from './bus.js';
import { InboundRouter } from './router.js';

// ─── Registry Entry ────────────────────────────────────────────────────────

interface AdapterEntry {
  adapter: ChannelAdapter;
  config: ChannelConfig;
  policy: ChannelPolicy;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  error?: string;
  startedAt?: number;
}

// ─── Registry ──────────────────────────────────────────────────────────────

export class ChannelRegistry {
  private adapters = new Map<string, AdapterEntry>();
  private bus: SymbioteBus;
  private router: InboundRouter;
  private activeSessions = new Set<string>();
  private onAdapterHealthChange?: (adapterId: string, health: AdapterHealth) => void;

  constructor(options?: {
    busOptions?: ConstructorParameters<typeof SymbioteBus>[0];
    globalOwnerIds?: string[];
    onAdapterHealthChange?: (adapterId: string, health: AdapterHealth) => void;
  }) {
    this.bus = new SymbioteBus(options?.busOptions);
    this.onAdapterHealthChange = options?.onAdapterHealthChange;

    this.router = new InboundRouter(this.bus, {
      policies: new Map(),
      globalOwnerIds: options?.globalOwnerIds,
      getActiveSessions: () => this.activeSessions,
    });
  }

  /** Get the message bus (for agent runner to subscribe) */
  getBus(): SymbioteBus {
    return this.bus;
  }

  /** Get the router (for policy updates) */
  getRouter(): InboundRouter {
    return this.router;
  }

  /** Mark a session as having an active agent turn (for interrupt detection) */
  setSessionActive(sessionId: string, active: boolean): void {
    if (active) {
      this.activeSessions.add(sessionId);
    } else {
      this.activeSessions.delete(sessionId);
    }
  }

  // ── Adapter Lifecycle ──────────────────────────────────────────────────

  /**
   * Register and start a channel adapter.
   * Hot-pluggable — can be called while the system is running.
   */
  async register(
    adapter: ChannelAdapter,
    config: ChannelConfig,
    policy: ChannelPolicy,
  ): Promise<void> {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter "${adapter.id}" is already registered`);
    }

    const entry: AdapterEntry = {
      adapter,
      config,
      policy,
      status: 'stopped',
    };
    this.adapters.set(adapter.id, entry);

    // Set policy in router
    this.router.setPolicy(adapter.channelType, policy);

    // Wire inbound messages through the router
    adapter.onMessage((envelope) => {
      this.router.route(envelope.source, envelope.payload, envelope.metadata.platformMessageId);
    });

    // Wire health changes
    adapter.onHealthChange((health) => {
      this.onAdapterHealthChange?.(adapter.id, health);
      if (health.state === 'connected') {
        // Reconnected successfully — restore running status
        if (entry.status === 'error' || entry.status === 'starting') {
          entry.status = 'running';
          entry.error = undefined;
          console.log(`[registry] Adapter ${adapter.id}: recovered → running`);
        }
      } else if (health.state === 'disconnected') {
        entry.status = 'error';
        entry.error = health.lastError;
        // Auto-reconnect with appropriate delay
        // 440 conflict = another socket took over, wait longer before retrying
        const is440 = health.lastError?.includes('440');
        const delay = is440 ? 30_000 : 2_000; // 30s for conflict, 2s for others
        if (is440) {
          console.log(`[registry] 440 conflict for ${adapter.id} — waiting ${delay/1000}s before reconnect`);
        }
        setTimeout(() => {
          adapter.reconnect().catch(err => {
            console.error(`[registry] Auto-reconnect failed for ${adapter.id}:`, err);
          });
        }, delay);
      }
    });

    // Start the adapter
    entry.status = 'starting';
    try {
      await adapter.connect(config);
      entry.status = 'running';
      entry.startedAt = Date.now();
    } catch (err) {
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Stop and remove an adapter. Hot-unplug.
   */
  async unregister(adapterId: string): Promise<void> {
    const entry = this.adapters.get(adapterId);
    if (!entry) return;

    entry.status = 'stopping';
    try {
      await entry.adapter.disconnect();
    } catch (err) {
      console.error(`[registry] Error disconnecting ${adapterId}:`, err);
    }
    this.adapters.delete(adapterId);
  }

  /**
   * Send a message through a specific adapter.
   */
  async send(adapterId: string, chatId: string, message: import('./types.js').OutboundMessage) {
    const entry = this.adapters.get(adapterId);
    if (!entry) throw new Error(`Adapter "${adapterId}" not found`);
    if (entry.status !== 'running') throw new Error(`Adapter "${adapterId}" is ${entry.status}`);
    return entry.adapter.send(chatId, message);
  }

  /**
   * Send through whatever adapter handles this channel type.
   */
  async sendToChannel(channelType: string, chatId: string, message: import('./types.js').OutboundMessage) {
    for (const [, entry] of this.adapters) {
      if (entry.adapter.channelType === channelType && entry.status === 'running') {
        return entry.adapter.send(chatId, message);
      }
    }
    throw new Error(`No running adapter for channel type "${channelType}"`);
  }

  // ── Status ─────────────────────────────────────────────────────────────

  /** List all registered adapters with their status */
  list(): Array<{
    id: string;
    channelType: string;
    status: string;
    health: AdapterHealth;
    startedAt?: number;
    error?: string;
  }> {
    return Array.from(this.adapters.entries()).map(([id, entry]) => ({
      id,
      channelType: entry.adapter.channelType,
      status: entry.status,
      health: entry.adapter.getHealth(),
      startedAt: entry.startedAt,
      error: entry.error,
    }));
  }

  /** Get a specific adapter */
  get(adapterId: string): ChannelAdapter | undefined {
    return this.adapters.get(adapterId)?.adapter;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    for (const [id] of this.adapters) {
      await this.unregister(id);
    }
    this.bus.destroy();
  }
}
