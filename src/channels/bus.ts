/**
 * Symbiote — Message Bus
 * 
 * Priority queue with interrupt support and backpressure.
 * In-process implementation. No external dependencies.
 * 
 * The bus is the nervous system. Every inbound message flows through it.
 * The agent runner subscribes to sessions. Interrupts bypass the queue.
 */

import { randomUUID } from 'node:crypto';
import type {
  BusEnvelope,
  BusSubscription,
  BusStats,
  MessageBus,
  MessagePriority,
} from './types.js';

// ─── Priority Weights ──────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  interrupt: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
};

// ─── Subscription ──────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  sessionId: string;
  handler: (envelope: BusEnvelope) => void;
  priorities?: Set<MessagePriority>;
  isInterruptOnly: boolean;
}

// ─── Bus Implementation ────────────────────────────────────────────────────

export class SymbioteBus implements MessageBus {
  private queue: BusEnvelope[] = [];
  private subscriptions = new Map<string, Subscription>();
  private sessionSubscriptions = new Map<string, Set<string>>(); // sessionId → sub IDs

  private _totalPublished = 0;
  private _totalDelivered = 0;
  private _totalDropped = 0;

  private readonly maxQueueDepth: number;
  private readonly coalesceWindowMs: number;
  private coalesceTimers = new Map<string, NodeJS.Timeout>(); // sessionId → timer
  private coalescePending = new Map<string, BusEnvelope[]>(); // sessionId → buffered envelopes

  private backpressureActive = false;
  private onBackpressure?: (active: boolean) => void;

  constructor(options?: {
    maxQueueDepth?: number;
    coalesceWindowMs?: number;
    onBackpressure?: (active: boolean) => void;
  }) {
    this.maxQueueDepth = options?.maxQueueDepth ?? 500;
    this.coalesceWindowMs = options?.coalesceWindowMs ?? 2000;
    this.onBackpressure = options?.onBackpressure;
  }

  // ── Publish ────────────────────────────────────────────────────────────

  publish(envelope: BusEnvelope): void {
    this._totalPublished++;

    // Interrupt priority bypasses everything — deliver immediately
    if (envelope.priority === 'interrupt') {
      this.deliverInterrupt(envelope);
      return;
    }

    // Backpressure check
    if (this.queue.length >= this.maxQueueDepth) {
      if (!this.backpressureActive) {
        this.backpressureActive = true;
        this.onBackpressure?.(true);
      }
      // Drop background messages under pressure
      if (envelope.priority === 'background') {
        this._totalDropped++;
        return;
      }
    } else if (this.backpressureActive && this.queue.length < this.maxQueueDepth * 0.8) {
      this.backpressureActive = false;
      this.onBackpressure?.(false);
    }

    const sessionId = envelope.sessionId;
    if (!sessionId) {
      // No session routed — queue for later routing
      this.insertSorted(envelope);
      return;
    }

    // Check if we should coalesce (same sender, rapid fire)
    if (this.coalesceWindowMs > 0 && envelope.payload.type === 'text') {
      this.bufferForCoalesce(sessionId, envelope);
      return;
    }

    this.insertSorted(envelope);
    this.tryDeliver(sessionId);
  }

  // ── Coalescing ─────────────────────────────────────────────────────────

  /**
   * Buffer messages from the same sender for a short window.
   * If they send multiple messages rapidly, coalesce into one envelope
   * before delivering to the agent.
   */
  private bufferForCoalesce(sessionId: string, envelope: BusEnvelope): void {
    // High priority skips coalescing
    if (envelope.priority === 'high') {
      this.flushCoalesce(sessionId);
      this.insertSorted(envelope);
      this.tryDeliver(sessionId);
      return;
    }

    const pending = this.coalescePending.get(sessionId) ?? [];
    pending.push(envelope);
    this.coalescePending.set(sessionId, pending);

    // Reset coalesce timer
    const existing = this.coalesceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    this.coalesceTimers.set(
      sessionId,
      setTimeout(() => this.flushCoalesce(sessionId), this.coalesceWindowMs),
    );
  }

  /**
   * Flush coalesced messages. If multiple text messages from same sender,
   * merge them into a single envelope.
   */
  private flushCoalesce(sessionId: string): void {
    const pending = this.coalescePending.get(sessionId);
    if (!pending || pending.length === 0) return;

    this.coalescePending.delete(sessionId);
    const timer = this.coalesceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.coalesceTimers.delete(sessionId);
    }

    if (pending.length === 1) {
      // Single message — no merging needed
      this.insertSorted(pending[0]);
    } else {
      // Multiple messages from same sender — merge text
      const sameSender = pending.every(
        e => e.source.senderId === pending[0].source.senderId,
      );

      if (sameSender) {
        const merged: BusEnvelope = {
          ...pending[0],
          id: randomUUID(),
          payload: {
            type: 'text',
            text: pending
              .map(e => e.payload.text)
              .filter(Boolean)
              .join('\n'),
            media: pending.flatMap(e => e.payload.media ?? []),
          },
          metadata: {
            ...pending[0].metadata,
            extra: {
              ...pending[0].metadata.extra,
              coalescedCount: pending.length,
              originalIds: pending.map(e => e.id),
            },
          },
        };
        this.insertSorted(merged);
      } else {
        // Different senders — can't merge, insert all
        for (const e of pending) this.insertSorted(e);
      }
    }

    this.tryDeliver(sessionId);
  }

  // ── Queue Management ───────────────────────────────────────────────────

  private insertSorted(envelope: BusEnvelope): void {
    const priority = PRIORITY_ORDER[envelope.priority] ?? 2;
    let i = this.queue.length;
    while (i > 0 && PRIORITY_ORDER[this.queue[i - 1].priority] > priority) {
      i--;
    }
    this.queue.splice(i, 0, envelope);
  }

  private tryDeliver(sessionId: string): void {
    const subIds = this.sessionSubscriptions.get(sessionId);
    if (!subIds) return;

    const toDeliver: BusEnvelope[] = [];
    const remaining: BusEnvelope[] = [];

    for (const env of this.queue) {
      if (env.sessionId === sessionId) {
        toDeliver.push(env);
      } else {
        remaining.push(env);
      }
    }

    if (toDeliver.length === 0) return;
    this.queue = remaining;

    for (const env of toDeliver) {
      for (const subId of subIds) {
        const sub = this.subscriptions.get(subId);
        if (!sub || sub.isInterruptOnly) continue;
        if (sub.priorities && !sub.priorities.has(env.priority)) continue;
        try {
          sub.handler(env);
          this._totalDelivered++;
        } catch (err) {
          console.error(`[symbiote-bus] Subscription handler error:`, err);
        }
      }
    }
  }

  private deliverInterrupt(envelope: BusEnvelope): void {
    const sessionId = envelope.sessionId;
    if (!sessionId) return;

    const subIds = this.sessionSubscriptions.get(sessionId);
    if (!subIds) return;

    for (const subId of subIds) {
      const sub = this.subscriptions.get(subId);
      if (!sub) continue;
      // Interrupt handlers AND regular handlers both receive interrupts
      try {
        sub.handler(envelope);
        this._totalDelivered++;
      } catch (err) {
        console.error(`[symbiote-bus] Interrupt handler error:`, err);
      }
    }
  }

  // ── Subscribe ──────────────────────────────────────────────────────────

  subscribe(
    sessionId: string,
    handler: (envelope: BusEnvelope) => void,
    filter?: { priorities?: MessagePriority[] },
  ): BusSubscription {
    const id = randomUUID();
    const sub: Subscription = {
      id,
      sessionId,
      handler,
      priorities: filter?.priorities ? new Set(filter.priorities) : undefined,
      isInterruptOnly: false,
    };

    this.subscriptions.set(id, sub);
    const sessionSubs = this.sessionSubscriptions.get(sessionId) ?? new Set();
    sessionSubs.add(id);
    this.sessionSubscriptions.set(sessionId, sessionSubs);

    // Immediately deliver any queued messages
    this.tryDeliver(sessionId);

    return {
      unsubscribe: () => {
        this.subscriptions.delete(id);
        sessionSubs.delete(id);
        if (sessionSubs.size === 0) this.sessionSubscriptions.delete(sessionId);
      },
    };
  }

  onInterrupt(
    sessionId: string,
    handler: (envelope: BusEnvelope) => void,
  ): BusSubscription {
    const id = randomUUID();
    const sub: Subscription = {
      id,
      sessionId,
      handler,
      isInterruptOnly: true,
    };

    this.subscriptions.set(id, sub);
    const sessionSubs = this.sessionSubscriptions.get(sessionId) ?? new Set();
    sessionSubs.add(id);
    this.sessionSubscriptions.set(sessionId, sessionSubs);

    return {
      unsubscribe: () => {
        this.subscriptions.delete(id);
        sessionSubs.delete(id);
        if (sessionSubs.size === 0) this.sessionSubscriptions.delete(sessionId);
      },
    };
  }

  // ── Drain / Peek ───────────────────────────────────────────────────────

  drain(sessionId: string, filter?: { priorities?: MessagePriority[] }): BusEnvelope[] {
    const prioritySet = filter?.priorities ? new Set(filter.priorities) : null;
    const drained: BusEnvelope[] = [];
    const remaining: BusEnvelope[] = [];

    for (const env of this.queue) {
      if (env.sessionId === sessionId && (!prioritySet || prioritySet.has(env.priority))) {
        drained.push(env);
      } else {
        remaining.push(env);
      }
    }

    this.queue = remaining;
    return drained;
  }

  pending(sessionId: string): number {
    return this.queue.filter(e => e.sessionId === sessionId).length;
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  stats(): BusStats {
    const pendingBySession = new Map<string, number>();
    for (const env of this.queue) {
      if (env.sessionId) {
        pendingBySession.set(env.sessionId, (pendingBySession.get(env.sessionId) ?? 0) + 1);
      }
    }
    return {
      totalPublished: this._totalPublished,
      totalDelivered: this._totalDelivered,
      totalDropped: this._totalDropped,
      pendingBySession,
      queueDepth: this.queue.length,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  destroy(): void {
    for (const timer of this.coalesceTimers.values()) clearTimeout(timer);
    this.coalesceTimers.clear();
    this.coalescePending.clear();
    this.subscriptions.clear();
    this.sessionSubscriptions.clear();
    this.queue = [];
  }
}
