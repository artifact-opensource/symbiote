/**
 * Symbiote — Inbound Router
 * 
 * Sits between channel adapters and the message bus.
 * Handles: policy enforcement, session routing, priority assignment,
 * deduplication, interrupt detection.
 * 
 * === MENTION-ONLY PROTOCOL (Day 21 — Ali's design) ===
 * 
 * ONE RULE FOR ALL BOTS:
 * 
 * A bot processes a message IF AND ONLY IF:
 *   1. It's a DM from an allowed sender, OR
 *   2. The message contains @mention of this bot's ID
 * 
 * When a bot WANTS to respond → include @mention of the target
 * When a bot does NOT want to respond → either:
 *   a) React with emoji (acknowledged, no text, no loop)
 *   b) Send text WITHOUT any @mention → hits chat, humans read it, no bot picks it up
 * 
 * This kills echo loops structurally. No cooldown timers. No sibling tracking.
 * No complex routing policies. Just: "does this message mention ME? No → ignore."
 * 
 * @end in any message = universal stop. No bot processes it. Period.
 */

import { randomUUID } from 'node:crypto';
import type {
  BusEnvelope,
  ChannelPolicy,
  ChannelSource,
  InboundPayload,
  MessagePriority,
  SessionRoute,
} from './types.js';
import type { SymbioteBus } from './bus.js';

// ─── WhatsApp JID Normalization ────────────────────────────────────────────

function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@s\.whatsapp\.net$/, '@s.whatsapp.net');
}

function jidMatches(jid: string, target: string): boolean {
  return normalizeJid(jid) === normalizeJid(target);
}

function jidInList(jid: string, list: string[]): boolean {
  const normalized = normalizeJid(jid);
  return list.some(item => normalizeJid(item) === normalized);
}

// ─── Interrupt Detection ───────────────────────────────────────────────────

const INTERRUPT_PATTERNS = [
  /^(stop|wait|hold on|pause|cancel|actually|never ?mind)/i,
  /^(no[,.]?\s|don'?t\s|abort)/i,
  /^(scratch that|forget it|hold up)/i,
];

// ─── Deduplication ─────────────────────────────────────────────────────────

class DeduplicationCache {
  private seen = new Map<string, number>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 10_000, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  check(id: string): boolean {
    const now = Date.now();
    this.evict(now);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }

  private evict(now: number): void {
    if (this.seen.size < this.maxSize) return;
    for (const [id, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(id);
    }
    if (this.seen.size >= this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
  }
}

// ─── Router ────────────────────────────────────────────────────────────────

export interface RouterConfig {
  /** Policy per channel type */
  policies: Map<string, ChannelPolicy>;
  /** Default policy if no channel-specific one exists */
  defaultPolicy?: ChannelPolicy;
  /** Global owner IDs — always allowed on any channel */
  globalOwnerIds?: string[];
  /** Active session tracking */
  getActiveSessions?: () => Set<string>;
}

export class InboundRouter {
  private bus: SymbioteBus;
  private config: RouterConfig;
  private dedup = new DeduplicationCache();
  private routes = new Map<string, SessionRoute>();
  private sessionCounter = 0;

  constructor(bus: SymbioteBus, config: RouterConfig) {
    this.bus = bus;
    this.config = config;
  }

  /**
   * Route an inbound message from a channel adapter.
   * Returns false if the message was rejected by policy.
   */
  route(source: ChannelSource, payload: InboundPayload, platformMessageId?: string): boolean {
    // 1. Deduplication
    const dedupKey = platformMessageId ?? `${source.adapterId}:${source.chatId}:${Date.now()}`;
    if (this.dedup.check(dedupKey)) return false;

    // 2. @end — universal conversation terminator. Any message containing @end
    // signals "do not respond." All bots honor this. No LLM turn, no reaction.
    if (payload.text && /@end\b/i.test(payload.text)) return false;

    // 3. Policy check (mention-only protocol)
    const policy = this.getPolicy(source.channelType);
    if (!this.checkPolicy(policy, source)) {
      if (source.chatType === 'group') {
        console.log(`[router] Group message from ${source.chatId} dropped by policy (no @mention match). mentions=${JSON.stringify(source.mentions ?? [])}, selfId=${policy.selfId}, aliases=${JSON.stringify(policy.selfIdAliases ?? [])}`);
      }
      return false;
    }

    // 4. Resolve session
    const sessionId = this.resolveSession(source);

    // 5. Determine priority
    const priority = this.assignPriority(policy, source, payload, sessionId);

    // 6. Build envelope
    const envelope: BusEnvelope = {
      id: randomUUID(),
      timestamp: Date.now(),
      priority,
      source,
      sessionId,
      payload,
      metadata: {
        platformMessageId,
        guildId: (source as any).guildId,
      },
    };

    // 7. Publish to bus
    this.bus.publish(envelope);
    return true;
  }

  // ── Policy ─────────────────────────────────────────────────────────────

  private getPolicy(channelType: string): ChannelPolicy {
    return this.config.policies.get(channelType) ?? this.config.defaultPolicy ?? {
      dmPolicy: 'deny',
      groupPolicy: 'deny',
      ownerIds: [],
    };
  }

  /**
   * Mention-Only Protocol (Day 21):
   * 
   * DMs: allowed senders get through (allowlist) or everyone (open)
   * Groups/Channels: message MUST contain @mention of this bot's selfId
   * 
   * That's it. No sibling yield. No groupPolicy modes. No requireMention toggle.
   * One rule: @mention me or I don't respond.
   */
  private checkPolicy(policy: ChannelPolicy, source: ChannelSource): boolean {
    // Ignored channels: completely blocked
    if (policy.ignoredChannels?.includes(source.chatId)) return false;

    // DMs — use DM policy (owner bypass, allowlist, open, deny)
    if (source.chatType === 'dm') {
      if (this.isOwner(policy, source.senderId)) return true;
      switch (policy.dmPolicy) {
        case 'open': return true;
        case 'allowlist': return jidInList(source.senderId, policy.allowedSenders ?? []);
        case 'deny': return false;
      }
    }

    // Groups, Channels, Threads — ONLY respond if @mentioned
    if (source.chatType === 'group' || source.chatType === 'channel' || source.chatType === 'thread') {
      return this.isMentioned(policy, source);
    }

    return false;
  }

  private isOwner(policy: ChannelPolicy, senderId: string): boolean {
    if (jidInList(senderId, policy.ownerIds)) return true;
    if (this.config.globalOwnerIds && jidInList(senderId, this.config.globalOwnerIds)) return true;
    return false;
  }

  private isMentioned(policy: ChannelPolicy, source: ChannelSource): boolean {
    if (!policy.selfId || !source.mentions) return false;
    // Check primary selfId AND any aliases (e.g. WhatsApp LID ↔ phone JID)
    const selfIds = [policy.selfId, ...(policy.selfIdAliases ?? [])];
    return source.mentions.some(m => selfIds.includes(m));
  }

  // ── Session Resolution ─────────────────────────────────────────────────

  private resolveSession(source: ChannelSource): string {
    const routeKey = `${source.adapterId}:${source.chatId}`;
    const existing = this.routes.get(routeKey);

    if (existing) {
      existing.lastActive = Date.now();
      return existing.sessionId;
    }

    const sessionId = `${source.adapterId}-${source.chatId}-${++this.sessionCounter}`;
    this.routes.set(routeKey, {
      channelType: source.channelType,
      chatId: source.chatId,
      sessionId,
      lastActive: Date.now(),
    });

    return sessionId;
  }

  // ── Priority Assignment ────────────────────────────────────────────────

  private assignPriority(
    policy: ChannelPolicy,
    source: ChannelSource,
    payload: InboundPayload,
    sessionId: string,
  ): MessagePriority {
    if (payload.type === 'typing' || payload.type === 'presence') return 'background';
    if (payload.type === 'reaction') return 'low';

    const isOwner = this.isOwner(policy, source.senderId);
    const text = payload.text?.trim() ?? '';

    const activeSessions = this.config.getActiveSessions?.() ?? new Set();
    const sessionActive = activeSessions.has(sessionId);

    if (isOwner && sessionActive) {
      if (INTERRUPT_PATTERNS.some(p => p.test(text))) {
        return 'interrupt';
      }
      return 'high';
    }

    if (isOwner) return 'high';
    if (source.chatType === 'dm') return 'normal';

    return 'normal'; // If we got here, we were @mentioned — that deserves normal priority
  }

  // ── Route Management ───────────────────────────────────────────────────

  getRoutes(): SessionRoute[] {
    return Array.from(this.routes.values());
  }

  getSessionId(adapterId: string, chatId: string): string | undefined {
    return this.routes.get(`${adapterId}:${chatId}`)?.sessionId;
  }

  setRoute(route: SessionRoute): void {
    this.routes.set(`${route.channelType}:${route.chatId}`, route);
  }

  pruneRoutes(maxIdleMs: number): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, route] of this.routes) {
      if (now - route.lastActive > maxIdleMs) {
        this.routes.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  setPolicy(channelType: string, policy: ChannelPolicy): void {
    this.config.policies.set(channelType, policy);
  }
}
