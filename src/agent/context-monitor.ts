// Symbiote — Proactive Context Management (fixes Pain #3)
// Track tokens in real-time. Compact before overflow. Never hit the wall.

import os from 'node:os';
import path from 'node:path';
import type { Message } from '../providers/types.js';

export interface ContextMonitorConfig {
  maxContextTokens: number;
  warnThreshold?: number;      // default 0.7
  compactThreshold?: number;   // default 0.8
  emergencyThreshold?: number; // default 0.9
  transcriptDir?: string;      // where to save emergency flushes
  onCombStage?: (content: string) => Promise<void>; // hook to COMB stage
}

export type ContextHealth = 'ok' | 'warning' | 'compacting' | 'emergency';

export interface ContextStatus {
  totalTokens: number;
  maxTokens: number;
  usage: number; // 0.0–1.0
  health: ContextHealth;
  messageCount: number;
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(msg: Message): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content);
  return (msg.content as Array<{ text?: string; content?: string; input?: Record<string, unknown> }>).reduce((sum, b) => {
    if (b.text) return sum + estimateTokens(b.text);
    if (b.content) return sum + estimateTokens(b.content);
    if (b.input) return sum + estimateTokens(JSON.stringify(b.input));
    return sum + 50;
  }, 0);
}

export class ContextMonitor {
  private config: Required<Pick<ContextMonitorConfig, 'maxContextTokens' | 'warnThreshold' | 'compactThreshold' | 'emergencyThreshold'>>;
  private transcriptDir: string;
  private onCombStage?: (content: string) => Promise<void>;
  private hasWarned = false;

  constructor(cfg: ContextMonitorConfig) {
    this.config = {
      maxContextTokens: cfg.maxContextTokens,
      warnThreshold: cfg.warnThreshold ?? 0.7,
      compactThreshold: cfg.compactThreshold ?? 0.8,
      emergencyThreshold: cfg.emergencyThreshold ?? 0.9,
    };
    this.transcriptDir = cfg.transcriptDir ?? path.join(os.tmpdir(), 'symbiote-transcripts');
    this.onCombStage = cfg.onCombStage;
  }

  /** Check current context health without modifying anything */
  check(messages: Message[]): ContextStatus {
    const totalTokens = messages.reduce((s, m) => s + messageTokens(m), 0);
    const usage = totalTokens / this.config.maxContextTokens;

    let health: ContextHealth = 'ok';
    if (usage >= this.config.emergencyThreshold) health = 'emergency';
    else if (usage >= this.config.compactThreshold) health = 'compacting';
    else if (usage >= this.config.warnThreshold) health = 'warning';

    return { totalTokens, maxTokens: this.config.maxContextTokens, usage, health, messageCount: messages.length };
  }

  /**
   * Check and act: returns (possibly compacted) messages.
   * - warning: logs, returns as-is
   * - compacting: COMB stage + summarize old messages
   * - emergency: save transcript to disk, hard-truncate
   */
  async manage(messages: Message[]): Promise<Message[]> {
    const status = this.check(messages);

    if (status.health === 'ok') {
      this.hasWarned = false;
      return messages;
    }

    if (status.health === 'warning') {
      if (!this.hasWarned) {
        console.warn(`⚠️  Context at ${(status.usage * 100).toFixed(0)}% (${status.totalTokens}/${status.maxTokens} tokens)`);
        this.hasWarned = true;
      }
      return messages;
    }

    // Before any compaction, stage to COMB
    if (this.onCombStage) {
      const summary = this.buildSummary(messages);
      try {
        await this.onCombStage(summary);
      } catch (err) {
        console.error('COMB stage failed during compaction:', err);
      }
    }

    if (status.health === 'emergency') {
      console.error(`🚨 Context EMERGENCY at ${(status.usage * 100).toFixed(0)}% — flushing to disk`);
      await this.saveTranscript(messages);
      return this.hardTruncate(messages, 10);
    }

    // compacting
    console.warn(`🔄 Context at ${(status.usage * 100).toFixed(0)}% — auto-compacting`);
    return this.compact(messages);
  }

  /** Summarize old messages, keep system + recent */
  private compact(messages: Message[]): Message[] {
    const system = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');

    // Keep last 40% of non-system messages
    const keepCount = Math.max(10, Math.floor(rest.length * 0.4));
    const old = rest.slice(0, rest.length - keepCount);
    const recent = rest.slice(rest.length - keepCount);

    // Build summary of old messages
    const summaryParts: string[] = ['[Context compacted. Summary of earlier conversation:]'];
    for (const msg of old) {
      const text = typeof msg.content === 'string' ? msg.content : '[structured content]';
      const preview = text.slice(0, 200);
      summaryParts.push(`${msg.role}: ${preview}${text.length > 200 ? '...' : ''}`);
    }
    const summaryMsg: Message = {
      role: 'user',
      content: summaryParts.join('\n').slice(0, 2000),
    };

    return [...system, summaryMsg, ...recent];
  }

  /** Emergency: save full transcript, keep only last N messages */
  private hardTruncate(messages: Message[], keepLast: number): Message[] {
    const system = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const kept = rest.slice(-keepLast);
    const notice: Message = { role: 'user', content: '[Emergency context flush. Earlier messages saved to disk. Recent context only.]' };
    return [...system, notice, ...kept];
  }

  private buildSummary(messages: Message[]): string {
    const parts: string[] = [`Context snapshot at ${new Date().toISOString()} (${messages.length} messages)`];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      parts.push(`[${msg.role}] ${text.slice(0, 500)}`);
    }
    return parts.join('\n');
  }

  private async saveTranscript(messages: Message[]): Promise<void> {
    // Dynamic import to avoid top-level fs dependency issues
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(this.transcriptDir, { recursive: true });
    const filename = `transcript-${Date.now()}.json`;
    const filepath = path.join(this.transcriptDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(messages, null, 2));
    console.log(`📝 Transcript saved: ${filepath}`);
  }
}
