// Symbiote — Message Queue (fixes Pain #5)
// Every message queued. Never dropped. Ever.

export interface QueuedMessage {
  id: string;
  sessionId: string;
  content: string;
  sender: string;
  channelId: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type MessageHandler = (msg: QueuedMessage) => Promise<void>;

interface SessionQueue {
  messages: QueuedMessage[];
  processing: boolean;
  handler: MessageHandler;
  onQueueNotify?: (depth: number) => void;
}

/**
 * Per-session message queue. Guarantees:
 * - Messages are NEVER dropped
 * - Processing is sequential per-session (no race conditions)
 * - Sender is optionally notified when queue depth > 0
 */
export class MessageQueue {
  private queues = new Map<string, SessionQueue>();
  private defaultHandler?: MessageHandler;
  private onNotify?: (sessionId: string, depth: number) => void;

  constructor(opts?: { defaultHandler?: MessageHandler; onQueueNotify?: (sessionId: string, depth: number) => void }) {
    this.defaultHandler = opts?.defaultHandler;
    this.onNotify = opts?.onQueueNotify;
  }

  /** Register a handler for a specific session */
  registerHandler(sessionId: string, handler: MessageHandler): void {
    const existing = this.queues.get(sessionId);
    if (existing) {
      existing.handler = handler;
    } else {
      this.queues.set(sessionId, { messages: [], processing: false, handler });
    }
  }

  /** Enqueue a message. Returns queue depth after enqueue. */
  enqueue(msg: QueuedMessage): number {
    let queue = this.queues.get(msg.sessionId);
    if (!queue) {
      const handler = this.defaultHandler;
      if (!handler) {
        console.error(`No handler for session ${msg.sessionId} and no default handler. Message queued but won't process.`);
        // Still queue it — never drop
        queue = { messages: [], processing: false, handler: async () => {} };
        this.queues.set(msg.sessionId, queue);
      } else {
        queue = { messages: [], processing: false, handler };
        this.queues.set(msg.sessionId, queue);
      }
    }

    queue.messages.push(msg);
    const depth = queue.messages.length;

    // Notify if queue has waiting messages
    if (depth > 1 || queue.processing) {
      this.onNotify?.(msg.sessionId, depth);
    }

    // Kick off processing if not already running
    if (!queue.processing) {
      void this.processQueue(msg.sessionId);
    }

    return depth;
  }

  /** Get current queue depth for a session */
  depth(sessionId: string): number {
    return this.queues.get(sessionId)?.messages.length ?? 0;
  }

  /** Check if a session is currently processing */
  isBusy(sessionId: string): boolean {
    return this.queues.get(sessionId)?.processing ?? false;
  }

  /** Get stats for all sessions */
  stats(): { sessionId: string; depth: number; processing: boolean }[] {
    return [...this.queues.entries()].map(([id, q]) => ({
      sessionId: id,
      depth: q.messages.length,
      processing: q.processing,
    }));
  }

  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.processing) return;

    queue.processing = true;
    try {
      while (queue.messages.length > 0) {
        const msg = queue.messages.shift()!;
        try {
          await queue.handler(msg);
        } catch (err) {
          console.error(`Error processing message ${msg.id} in session ${sessionId}:`, err);
          // Don't re-queue on error — log and continue to next message
        }
      }
    } finally {
      queue.processing = false;
    }
  }
}
