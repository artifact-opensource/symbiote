/**
 * Symbiote — Channel System Type Definitions
 * 
 * Core types for the message bus, channel adapters, and routing layer.
 * Zero dependencies. This file imports nothing.
 */

// ─── Bus Envelope ──────────────────────────────────────────────────────────

export type MessagePriority = 'interrupt' | 'high' | 'normal' | 'low' | 'background';

export interface BusEnvelope {
  /** Unique envelope ID (UUID) */
  id: string;
  /** When the envelope entered the bus */
  timestamp: number;
  /** Processing priority */
  priority: MessagePriority;
  /** Where this message came from */
  source: ChannelSource;
  /** Which session should handle it (resolved by router) */
  sessionId?: string;
  /** The actual message content */
  payload: InboundPayload;
  /** Platform-specific preserved data */
  metadata: EnvelopeMetadata;
}

export interface ChannelSource {
  /** Channel type: "discord", "whatsapp", "telegram", etc. */
  channelType: string;
  /** Adapter instance ID: "discord-main", "wa-0987654321" */
  adapterId: string;
  /** Chat/conversation identifier on the platform */
  chatId: string;
  /** Chat type */
  chatType: 'dm' | 'group' | 'channel' | 'thread';
  /** Sender's platform-specific ID */
  senderId: string;
  /** Sender display name */
  senderName?: string;
  /** If this is a reply, the message being replied to */
  replyToId?: string;
  /** Thread ID if in a thread */
  threadId?: string;
  /** Mentioned user IDs */
  mentions?: string[];
}

// ─── Payloads ──────────────────────────────────────────────────────────────

export type PayloadType = 'text' | 'media' | 'reaction' | 'edit' | 'delete' | 'typing' | 'presence' | 'system';

export interface InboundPayload {
  type: PayloadType;
  text?: string;
  media?: MediaPayload[];
  reaction?: ReactionPayload;
  edit?: EditPayload;
  /** Original platform event — never discarded, never parsed by core */
  raw?: unknown;
}

export interface MediaPayload {
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'voice';
  url?: string;
  path?: string;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  /** Caption text (for platforms that support media + caption) */
  caption?: string;
}

export interface ReactionPayload {
  emoji: string;
  messageId: string;
  remove?: boolean;
}

export interface EditPayload {
  messageId: string;
  newText: string;
}

export interface EnvelopeMetadata {
  /** Platform-specific message ID */
  platformMessageId?: string;
  /** Guild/server ID (Discord, Slack) */
  guildId?: string;
  /** Is this an ephemeral/disappearing message? */
  ephemeral?: boolean;
  /** Forwarded from another chat? */
  forwarded?: boolean;
  /** Additional platform data */
  extra?: Record<string, unknown>;
}

// ─── Outbound ──────────────────────────────────────────────────────────────

export interface OutboundMessage {
  /** Markdown content (agent output) */
  content: string;
  /** Media attachments */
  media?: MediaPayload[];
  /** Reply to a specific message */
  replyToId?: string;
  /** Post in a thread */
  threadId?: string;
  /** Ephemeral/disappearing */
  ephemeral?: boolean;
  /** Interactive components (buttons, keyboards) */
  components?: MessageComponent[];
  /** How to handle messages exceeding platform limit */
  splitStrategy?: 'truncate' | 'paginate' | 'thread';
  /** Priority for rate limiting */
  priority?: 'interactive' | 'proactive' | 'background';
}

export interface MessageComponent {
  type: 'button' | 'select' | 'action_row';
  label?: string;
  value?: string;
  style?: string;
  children?: MessageComponent[];
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /** Timestamp when actually delivered (if platform confirms) */
  deliveredAt?: number;
}

// ─── Channel Adapter ───────────────────────────────────────────────────────

export type AdapterHealthState = 'connected' | 'degraded' | 'disconnected' | 'reconnecting';

export interface AdapterHealth {
  state: AdapterHealthState;
  lastConnected: number;
  disconnectCount: number;
  lastError?: string;
  uptimePercent?: number;
  latencyMs?: number;
}

export interface ChannelCapabilities {
  media: boolean;
  reactions: boolean;
  messageEdit: boolean;
  messageDelete: boolean;
  threads: boolean;
  embeds: boolean;
  components: boolean;
  voiceNotes: boolean;
  readReceipts: boolean;
  typingIndicator: boolean;
  ephemeral: boolean;
  polls: boolean;
  /** Platform's native formatting dialect */
  formatting: 'markdown' | 'html' | 'plain' | 'whatsapp' | 'slack-mrkdwn';
  /** Maximum message length in characters */
  maxMessageLength: number;
  /** Maximum media size in bytes */
  maxMediaSize: number;
  /** Rate limits */
  rateLimits: RateLimitConfig;
}

export interface RateLimitConfig {
  messagesPerSecond?: number;
  messagesPerMinute?: number;
  burstSize?: number;
}

export interface ChannelConfig {
  /** Adapter-specific configuration (API keys, tokens, etc.) */
  [key: string]: unknown;
}

/**
 * Channel Adapter — the contract every platform adapter implements.
 * 
 * 5 core methods + optional platform-specific actions.
 * Adapters own their platform SDK. The bus and agent never touch it.
 */
export interface ChannelAdapter {
  /** Unique adapter instance ID */
  readonly id: string;
  /** Channel type identifier */
  readonly channelType: string;
  /** What this platform supports */
  readonly capabilities: ChannelCapabilities;

  // ── Lifecycle ──

  /** Initialize and connect to the platform */
  connect(config: ChannelConfig, signal?: AbortSignal): Promise<void>;
  /** Graceful disconnect */
  disconnect(): Promise<void>;
  /** Force reconnect (after disconnect/error) */
  reconnect(): Promise<void>;
  /** Current health status */
  getHealth(): AdapterHealth;

  // ── Inbound ──

  /** Register handler for incoming messages. Adapter normalizes and calls handler. */
  onMessage(handler: (envelope: BusEnvelope) => void): void;
  /** Register handler for health state changes */
  onHealthChange(handler: (health: AdapterHealth) => void): void;

  // ── Outbound ──

  /** Send a message to a target chat */
  send(chatId: string, message: OutboundMessage): Promise<SendResult>;

  // ── Optional Platform Actions ──

  /** React to a message with an emoji */
  react?(chatId: string, messageId: string, emoji: string): Promise<void>;
  /** Edit a previously sent message */
  editMessage?(chatId: string, messageId: string, newContent: string): Promise<void>;
  /** Delete a message */
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  /** Send typing indicator */
  typing?(chatId: string, durationMs?: number): Promise<void>;
  /** Mark a message as read */
  markRead?(chatId: string, messageId: string): Promise<void>;
}

// ─── Routing ───────────────────────────────────────────────────────────────

export interface ChannelPolicy {
  /** DM handling: open to all, allowlist only, or deny all */
  dmPolicy: 'open' | 'allowlist' | 'deny';
  /** Group handling — kept for config compat. Router uses @mention-only protocol. */
  groupPolicy: 'open' | 'allowlist' | 'mention-only' | 'deny';
  /** Allowed sender IDs (for DM allowlist mode) */
  allowedSenders?: string[];
  /** Allowed group IDs — kept for config compat */
  allowedGroups?: string[];
  /** Owner IDs — always allowed in DMs, always high priority */
  ownerIds: string[];
  /** Bot's own ID on this platform (REQUIRED for @mention detection) */
  selfId?: string;
  /** Alternate IDs for the same bot (e.g. WhatsApp LID alongside phone JID) */
  selfIdAliases?: string[];
  /** Channel IDs to completely ignore — no processing, no response, no session creation */
  ignoredChannels?: string[];
  // ── Day 21: Mention-Only Protocol ──────────────────────────────────
  // In groups/channels, a message is processed ONLY if it @mentions selfId.
  // When responding, include @mention of target. When not responding, either
  // react with emoji or send without @mention (humans read it, bots ignore it).
  // siblingBotIds, requireMention, strictMentionChannels — REMOVED.
  // The @mention check is the ONLY routing rule. No cooldowns. No complexity.
}

export interface SessionRoute {
  /** Channel type + chat ID → session ID mapping */
  channelType: string;
  chatId: string;
  sessionId: string;
  /** When this route was last active */
  lastActive: number;
}

// ─── Message Bus ───────────────────────────────────────────────────────────

export type BusEventType = 'message' | 'interrupt' | 'drain' | 'backpressure' | 'health';

export interface BusEvent {
  type: BusEventType;
  envelope?: BusEnvelope;
  sessionId?: string;
  data?: unknown;
}

export type BusSubscription = {
  unsubscribe(): void;
};

export interface MessageBus {
  /** Publish an envelope to the bus */
  publish(envelope: BusEnvelope): void;

  /** Subscribe to messages for a session (filtered by priority) */
  subscribe(
    sessionId: string,
    handler: (envelope: BusEnvelope) => void,
    filter?: { priorities?: MessagePriority[] },
  ): BusSubscription;

  /** Subscribe to interrupt signals for a session */
  onInterrupt(
    sessionId: string,
    handler: (envelope: BusEnvelope) => void,
  ): BusSubscription;

  /** Drain all pending messages for a session (removes from queue) */
  drain(sessionId: string, filter?: { priorities?: MessagePriority[] }): BusEnvelope[];

  /** Peek at pending count without draining */
  pending(sessionId: string): number;

  /** Current bus stats */
  stats(): BusStats;
}

export interface BusStats {
  totalPublished: number;
  totalDelivered: number;
  totalDropped: number;
  pendingBySession: Map<string, number>;
  queueDepth: number;
}

// ─── Formatter ─────────────────────────────────────────────────────────────

export interface OutboundFormatter {
  /** Convert markdown to platform-native format */
  format(markdown: string, capabilities: ChannelCapabilities): string;
  /** Split content into chunks that fit platform limits */
  split(content: string, maxLength: number): string[];
}

// ─── Health Tracker ────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<AdapterHealthState, AdapterHealthState[]> = {
  connected: ['degraded', 'disconnected'],
  degraded: ['connected', 'disconnected'],
  disconnected: ['reconnecting', 'connected'],
  reconnecting: ['connected', 'disconnected'],
};

export class HealthTracker {
  private _state: AdapterHealthState = 'disconnected';
  private _lastConnected = 0;
  private _disconnectCount = 0;
  private _lastError?: string;
  private _connectedSince = 0;
  private _totalConnectedMs = 0;
  private _trackingSince = Date.now();
  private _handlers: Array<(health: AdapterHealth) => void> = [];

  get state(): AdapterHealthState { return this._state; }

  get status(): AdapterHealth {
    const now = Date.now();
    let connectedMs = this._totalConnectedMs;
    if (this._state === 'connected' && this._connectedSince > 0) {
      connectedMs += now - this._connectedSince;
    }
    const totalMs = now - this._trackingSince;
    return {
      state: this._state,
      lastConnected: this._lastConnected,
      disconnectCount: this._disconnectCount,
      lastError: this._lastError,
      uptimePercent: totalMs > 0 ? Math.round((connectedMs / totalMs) * 100) : 0,
    };
  }

  transition(to: AdapterHealthState, error?: string): boolean {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed?.includes(to)) return false;

    const now = Date.now();
    if (this._state === 'connected' && this._connectedSince > 0) {
      this._totalConnectedMs += now - this._connectedSince;
      this._connectedSince = 0;
    }
    if (to === 'connected') {
      this._lastConnected = now;
      this._connectedSince = now;
    }
    if (to === 'disconnected') {
      this._disconnectCount++;
      if (error) this._lastError = error;
    }

    this._state = to;
    const status = this.status;
    for (const h of this._handlers) h(status);
    return true;
  }

  onChange(handler: (health: AdapterHealth) => void): void {
    this._handlers.push(handler);
  }
}
