// Symbiote — Session lifecycle manager

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message } from '../providers/types.js';
import type { Session, SessionSummary, SessionMetadata } from './types.js';

const DEFAULT_DIR = '.symbiote/sessions';
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Sanitize message history to remove orphaned tool results/calls.
 * A tool result (role=tool with tool_call_id) is orphaned if no preceding
 * assistant message has a matching tool_call. This prevents Anthropic API 400 errors.
 */
function sanitizeToolPairs(messages: Message[]): Message[] {
  const precedingToolCallIds = new Set<string>();
  const filtered: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      precedingToolCallIds.clear();
      for (const tc of msg.tool_calls ?? []) precedingToolCallIds.add(tc.id);
      if (typeof msg.content !== 'string') {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) precedingToolCallIds.add(block.id);
        }
      }
    } else if (msg.role !== 'tool' && (typeof msg.content === 'string' || !msg.content.some(block => block.type === 'tool_result'))) {
      precedingToolCallIds.clear();
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      if (!precedingToolCallIds.has(msg.tool_call_id)) {
        console.log(`[sessions] Dropping orphaned tool result: ${msg.tool_call_id}`);
        continue;
      }
      precedingToolCallIds.delete(msg.tool_call_id);
    }

    if (typeof msg.content !== 'string' && msg.content.some(b => b.type === 'tool_result')) {
      const hasOrphan = msg.content.some(b => b.type === 'tool_result' && b.tool_use_id && !precedingToolCallIds.has(b.tool_use_id));
      if (hasOrphan) {
        const validBlocks = msg.content.filter(b => {
          if (b.type === 'tool_result' && b.tool_use_id && !precedingToolCallIds.has(b.tool_use_id)) {
            console.log(`[sessions] Dropping orphaned tool_result block: ${b.tool_use_id}`);
            return false;
          }
          return true;
        });
        if (validBlocks.length === 0) continue;
        msg.content = validBlocks;
      }
    }

    if (typeof msg.content !== 'string') {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) precedingToolCallIds.delete(block.tool_use_id);
      }
    }
    filtered.push(msg);
    if (msg.role === 'user' || msg.role === 'system') precedingToolCallIds.clear();
  }
  return filtered;
}

function toolCallIds(message: Message): string[] {
  const ids = (message.tool_calls ?? []).map(call => call.id);
  if (typeof message.content !== 'string') {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) ids.push(block.id);
    }
  }
  return ids;
}

function toolResultIds(message: Message): string[] {
  const ids = message.role === 'tool' && message.tool_call_id ? [message.tool_call_id] : [];
  if (typeof message.content !== 'string') {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) ids.push(block.tool_use_id);
    }
  }
  return ids;
}

function safeArchiveBoundary(messages: Message[], requestedBoundary: number): number {
  let boundary = Math.max(0, Math.min(messages.length, requestedBoundary));
  for (let index = 0; index < boundary; index++) {
    const callIds = toolCallIds(messages[index]);
    if (callIds.length === 0) continue;
    const callIdSet = new Set(callIds);
    const hasResultAfterBoundary = messages.slice(boundary).some(message =>
      toolResultIds(message).some(id => callIdSet.has(id)),
    );
    if (hasResultAfterBoundary) boundary = index;
  }
  return boundary;
}

export class SessionManager {
  private dir: string;
  private ttl: number;

  constructor(baseDir?: string, ttl?: number) {
    this.dir = baseDir ?? path.join(os.homedir(), DEFAULT_DIR);
    this.ttl = ttl ?? DEFAULT_TTL;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_\-:.]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  private defaultMetadata(): SessionMetadata {
    return { messageCount: 0, tokenUsage: { input: 0, output: 0 }, toolsUsed: {}, depth: 0 };
  }

  create(id: string, opts?: { label?: string; provider?: string; model?: string; parentSessionId?: string; depth?: number }): Session {
    const session: Session = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      metadata: {
        ...this.defaultMetadata(),
        label: opts?.label,
        provider: opts?.provider,
        model: opts?.model,
        parentSessionId: opts?.parentSessionId,
        depth: opts?.depth ?? 0,
      },
    };
    this.save(session);
    return session;
  }

  load(id: string): Session | null {
    let data: Session;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath(id), 'utf-8')) as Session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Failed to load session ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    // Backfill metadata for old sessions
    if (!data.metadata || typeof data.metadata !== 'object' || !('messageCount' in data.metadata)) {
      data.metadata = { ...this.defaultMetadata(), ...(data.metadata as Record<string, unknown> ?? {}) } as SessionMetadata;
    }
    // Sanitize tool pairs — persist cleanup so stale results are not dropped on every load.
    const originalMessages = JSON.stringify(data.messages);
    data.messages = sanitizeToolPairs(data.messages);
    if (JSON.stringify(data.messages) !== originalMessages) this.save(data);
    return data;
  }

  save(session: Session): void {
    session.updatedAt = Date.now();
    session.metadata.messageCount = session.messages.length;
    const destination = this.filePath(session.id);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(session, null, 2));
    fs.renameSync(temporary, destination);
  }

  delete(id: string): boolean {
    try { fs.unlinkSync(this.filePath(id)); return true; } catch { return false; }
  }

  list(): SessionSummary[] {
    try {
      const summaries: SessionSummary[] = [];
      for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as Session;
          summaries.push({
            id: s.id,
            label: s.metadata?.label,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length,
            provider: s.metadata?.provider,
            model: s.metadata?.model,
          });
        } catch { /* skip */ }
      }
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  /** Update token usage */
  trackUsage(session: Session, input: number, output: number): void {
    session.metadata.tokenUsage.input += input;
    session.metadata.tokenUsage.output += output;
  }

  /** Track tool call */
  trackToolCall(session: Session, toolName: string): void {
    session.metadata.toolsUsed[toolName] = (session.metadata.toolsUsed[toolName] ?? 0) + 1;
  }

  /** Clean up stale sessions older than TTL */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    try {
      for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as Session;
          if (now - s.updatedAt > this.ttl) {
            fs.unlinkSync(path.join(this.dir, f));
            cleaned++;
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* dir doesn't exist */ }
    return cleaned;
  }

  /** Rename / label a session */
  setLabel(id: string, label: string): boolean {
    const session = this.load(id);
    if (!session) return false;
    session.metadata.label = label;
    this.save(session);
    return true;
  }

  // ── Session Archival ─────────────────────────────────────────────────────

  private archiveDir(): string {
    const dir = path.join(this.dir, 'archive');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Archive a session: move old messages to an archive file, keep only
   * the system prompt + last N messages in the active session.
   * Returns number of messages archived.
   */
  archive(id: string, keepMessages = 20): number {
    const session = this.load(id);
    if (!session || session.messages.length <= keepMessages) return 0;

    // Separate system prompt from conversation
    const systemMsgs = session.messages.filter(m => m.role === 'system');
    const convMsgs = session.messages.filter(m => m.role !== 'system');

    if (convMsgs.length <= keepMessages) return 0;

    // Archive the old messages
    const requestedBoundary = convMsgs.length - keepMessages;
    const boundary = safeArchiveBoundary(convMsgs, requestedBoundary);
    const toArchive = convMsgs.slice(0, boundary);
    const toKeep = convMsgs.slice(boundary);

    const archiveFile = path.join(this.archiveDir(), `${id.replace(/[^a-zA-Z0-9_\-:.]/g, '_')}-${Date.now()}.json`);
    const archiveData = {
      sessionId: id,
      archivedAt: Date.now(),
      messageCount: toArchive.length,
      tokenUsage: { ...session.metadata.tokenUsage },
      messages: toArchive,
    };
    fs.writeFileSync(archiveFile, JSON.stringify(archiveData));

    // Update active session
    session.messages = [...systemMsgs, ...toKeep];
    this.save(session);

    console.log(`[sessions] Archived ${toArchive.length} messages from ${id} → ${path.basename(archiveFile)}`);
    return toArchive.length;
  }

  /**
   * Auto-archive sessions that exceed a size threshold.
   * Call periodically (e.g., after each agent turn).
   */
  autoArchive(maxSizeBytes = 200 * 1024, keepMessages = 30): number {
    let totalArchived = 0;
    try {
      for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
        const fp = path.join(this.dir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.size > maxSizeBytes) {
            const id = f.replace('.json', '').replace(/_/g, '/');
            // Load to get actual ID
            const session = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Session;
            totalArchived += this.archive(session.id, keepMessages);
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }
    return totalArchived;
  }

}
