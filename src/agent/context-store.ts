// Symbiote — Context Store
//
// The bridge between attention (context window) and memory (vdb).
//
// Problem: truncateContext drops messages to fit the token budget.
//          Those messages vanish — no trace, no retrieval path.
//          The agent confabulates because it doesn't know what it lost.
//
// Solution: Every dropped message gets vectorized into vdb.
//           Every iteration, recent context queries vdb for relevant prior knowledge.
//           The context window becomes a sliding viewport over persistent memory.
//           Nothing is ever truly lost — just not currently attended to.
//
// Flow:
//   1. Boot: heavy ingest (identity files, recent memory, COMB)
//   2. Every iteration (before LLM call):
//      a. Query vdb with recent messages → get relevant prior context
//      b. Inject as retrieval block after system prompt
//   3. On truncation: diff before/after, absorb dropped messages into vdb
//   4. Cross-session: vdb persists to disk, loads on next boot
//
// "The context window is attention. The vdb is memory.
//  Attention is small and focused. Memory is large and searchable."

import type { Message } from '../providers/types.js';
import type { VectorDB, VDBDocument, SearchResult } from '../memory/vdb.js';

// ── Config ───────────────────────────────────────────────────────────────

export interface ContextStoreConfig {
  /** Max retrieved chunks to inject per iteration */
  retrievalK: number;
  /** Min relevance score to include (0-1, after normalization) */
  retrievalThreshold: number;
  /** Max tokens to spend on retrieved context */
  retrievalBudget: number;
  /** How many recent messages to use as retrieval query */
  queryDepth: number;
  /** Source tag for absorbed messages */
  sessionSource: string;
  /** Current session ID */
  sessionId: string;
}

export const DEFAULT_CONTEXT_STORE_CONFIG: ContextStoreConfig = {
  retrievalK: 5,
  retrievalThreshold: 0.15,
  retrievalBudget: 3000, // ~12K chars, enough for meaningful context
  queryDepth: 3,
  sessionSource: 'session',
  sessionId: 'unknown',
};

// ── Rough token estimation (matches context.ts) ─────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Context Store ────────────────────────────────────────────────────────

export class ContextStore {
  private vdb: VectorDB;
  private config: ContextStoreConfig;
  private absorbedIds: Set<string> = new Set(); // prevent re-absorbing same messages

  constructor(vdb: VectorDB, config?: Partial<ContextStoreConfig>) {
    this.vdb = vdb;
    this.config = { ...DEFAULT_CONTEXT_STORE_CONFIG, ...config };
  }

  /**
   * Retrieve relevant prior context for the current conversation state.
   * Called before each LLM call.
   * 
   * @param messages - current conversation messages (post-truncation)
   * @returns A retrieval message to inject, or null if nothing relevant found
   */
  retrieve(messages: Message[]): Message | null {
    // Build query from recent non-system messages
    const nonSystem = messages.filter(m => m.role !== 'system');
    const recent = nonSystem.slice(-this.config.queryDepth);

    if (recent.length === 0) return null;

    // Build query string from recent messages
    const queryParts: string[] = [];
    for (const msg of recent) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as Array<{ text?: string }>)
            .map(b => b.text ?? '')
            .filter(t => t.length > 0)
            .join(' ');

      if (text.length > 10) {
        // Take first 500 chars — enough for semantic matching without noise
        queryParts.push(text.slice(0, 500));
      }
    }

    const query = queryParts.join(' ');
    if (query.length < 20) return null;

    // Search vdb
    const results = this.vdb.search(query, this.config.retrievalK * 2); // over-fetch, filter by threshold

    // Filter by threshold and dedup against current context
    const currentTexts = new Set(
      nonSystem
        .map(m => typeof m.content === 'string' ? m.content.slice(0, 100) : '')
        .filter(t => t.length > 0)
    );

    const relevant: SearchResult[] = [];
    let tokenBudget = this.config.retrievalBudget;

    for (const result of results) {
      if (result.score < this.config.retrievalThreshold) continue;

      // Skip if this content is already in the current context window
      const preview = result.text.slice(0, 100);
      if (currentTexts.has(preview)) continue;

      const tokens = estimateTokens(result.text);
      if (tokens > tokenBudget) continue;

      relevant.push(result);
      tokenBudget -= tokens;

      if (relevant.length >= this.config.retrievalK) break;
    }

    if (relevant.length === 0) return null;

    // Format as a retrieval block
    const parts: string[] = [
      '[RETRIEVED CONTEXT — relevant prior knowledge from your memory]:',
    ];

    for (const r of relevant) {
      const age = this.formatAge(r.timestamp);
      const source = r.source === 'absorbed' ? 'earlier this conversation' : r.source;
      parts.push(`[${source}, ${age}, relevance=${(r.score * 100).toFixed(0)}%] ${r.text}`);
    }

    return {
      role: 'user',
      content: parts.join('\n\n'),
    };
  }

  /**
   * Absorb messages that were dropped by truncation.
   * Called after truncateContext with the diff.
   * 
   * @param dropped - messages that were removed from context
   */
  absorb(dropped: Message[]): number {
    let absorbed = 0;

    for (const msg of dropped) {
      // Skip system messages (already permanent in prompt)
      if (msg.role === 'system') continue;

      // Skip tool results — too noisy, low semantic value
      if (msg.role === 'tool') continue;

      // Extract text
      let text: string;
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else {
        text = (msg.content as Array<{ text?: string; content?: string }>)
          .map(b => b.text ?? b.content ?? '')
          .filter(t => t.length > 0)
          .join('\n');
      }

      // Skip empty, too short, or system noise
      if (text.length < 30) continue;
      if (text.startsWith('[Context compacted') || text.startsWith('[Emergency context flush')) continue;
      if (text.includes('BLINK APPROACHING') || text.includes('BLINK COMPLETE')) continue;
      if (text.includes('SYSTEM WARNING:') && text.includes('Wrap up NOW')) continue;

      // Deduplicate — hash the content
      const contentKey = `${msg.role}:${text.slice(0, 200)}`;
      if (this.absorbedIds.has(contentKey)) continue;
      this.absorbedIds.add(contentKey);

      // For assistant messages with tool_calls, extract the text reasoning only
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // The text part of a tool-calling message is the reasoning — valuable
        if (text.length < 30) continue;
      }

      // Vectorize into vdb
      const doc: VDBDocument = {
        id: '', // vdb will generate
        text: text.length > 2000 ? text.slice(0, 2000) : text,
        source: 'absorbed',
        role: msg.role,
        timestamp: Date.now(),
        sessionId: this.config.sessionId,
      };

      if (this.vdb.index(doc)) {
        absorbed++;
      }
    }

    if (absorbed > 0) {
      console.log(`  [context-store] Absorbed ${absorbed} dropped messages into memory`);
    }

    return absorbed;
  }

  /**
   * Wrap truncateContext with absorption.
   * Drop-in replacement that truncates AND absorbs what was dropped.
   * 
   * @param messages - full message array
   * @param maxTokens - token budget
   * @param truncateFn - the original truncateContext function
   * @returns truncated messages (dropped ones are absorbed)
   */
  truncateAndAbsorb(
    messages: Message[],
    maxTokens: number,
    truncateFn: (msgs: Message[], max: number) => Message[],
  ): Message[] {
    const truncated = truncateFn(messages, maxTokens);

    // Find what was dropped
    if (truncated.length < messages.length) {
      const keptSet = new Set(truncated);
      const dropped = messages.filter(m => !keptSet.has(m));
      if (dropped.length > 0) {
        this.absorb(dropped);
      }
    }

    return truncated;
  }

  /**
   * Boot-time ingestion of identity and memory files.
   * Called once at session start to prime the vdb with foundational context.
   */
  ingestBoot(texts: Array<{ text: string; source: string }>): number {
    let indexed = 0;
    for (const { text, source } of texts) {
      // Chunk long texts into ~500 token segments for better retrieval granularity
      const chunks = this.chunk(text, 500);
      for (const chunk of chunks) {
        const doc: VDBDocument = {
          id: '',
          text: chunk,
          source,
          role: 'context',
          timestamp: Date.now(),
          sessionId: 'boot',
        };
        if (this.vdb.index(doc)) indexed++;
      }
    }
    if (indexed > 0) {
      console.log(`  [context-store] Boot ingest: ${indexed} chunks from ${texts.length} sources`);
    }
    return indexed;
  }

  /** Get vdb stats */
  stats() {
    return this.vdb.stats();
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private chunk(text: string, targetTokens: number): string[] {
    const targetChars = targetTokens * 4;
    if (text.length <= targetChars) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';

    for (const para of paragraphs) {
      if (current.length + para.length > targetChars && current.length > 0) {
        chunks.push(current.trim());
        current = '';
      }
      current += para + '\n\n';
    }
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }
    return chunks;
  }

  private formatAge(timestamp: number): string {
    const ageMs = Date.now() - timestamp;
    const mins = Math.floor(ageMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
