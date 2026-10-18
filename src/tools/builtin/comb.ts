// Symbiote — COMB: Lossless Operational Memory
//
// Thin wrappers over VDB. Zero file storage. Zero JSON. Zero rollup.
// Stage → VDB index. Recall → VDB recent query. That's it.

import type { ToolDefinition } from '../types.js';

// ── VDB Hook ─────────────────────────────────────────────────────────────

// VDB index + recent query hooks — set by daemon to avoid circular imports
let _vdbIndex: ((text: string, source: string) => boolean | void) | null = null;
let _vdbRecent: ((source: string, k: number) => Array<{ text: string; timestamp: number }>) | null = null;
let _vdbSearch: ((query: string, k: number, namespace: string) => Array<{ text: string; timestamp: number; score: number }>) | null = null;
let _memoryOffload: ((summary: string, sessionId: string, source: string) => { id: string; shardHash: string; duplicate: boolean }) | null = null;

export function setCombVdbHook(
  indexFn: (text: string, source: string) => boolean | void,
  recentFn?: (source: string, k: number) => Array<{ text: string; timestamp: number }>,
  searchFn?: (query: string, k: number, namespace: string) => Array<{ text: string; timestamp: number; score: number }>,
): void {
  _vdbIndex = indexFn;
  _vdbRecent = recentFn ?? null;
  _vdbSearch = searchFn ?? null;
}

export function setMemoryOffloadHook(
  offloadFn: (summary: string, sessionId: string, source: string) => { id: string; shardHash: string; duplicate: boolean },
): void {
  _memoryOffload = offloadFn;
}

// ── Stage (index into VDB) ───────────────────────────────────────────────

function stage(text: string, source = 'comb'): boolean {
  if (!_vdbIndex) {
    throw new Error('Memory backend is not initialized; nothing was staged.');
  }
  return _vdbIndex(text, source) !== false;
}

// ── Recall (query VDB for recent comb entries) ───────────────────────────

function recall(query?: string, k = 12): string {
  if (query?.trim() && _vdbSearch) {
    const entries = _vdbSearch(query.trim(), k, 'memograph:symbiote_live:live:agent:symbiote');
    if (entries.length === 0) return `=== COMB RECALL ===\n\nNo relevant durable memories found for: ${query.trim()}`;
    return [
      '=== COMB RECALL — Similarity-matched durable memories ===',
      'These are historical memories, not live system state. Verify volatile facts before relying on them.',
      '',
      ...entries.flatMap(entry => [
        `[${new Date(entry.timestamp).toISOString()} · relevance=${entry.score.toFixed(3)}]`,
        entry.text,
        '',
      ]),
    ].join('\n');
  }

  if (!_vdbRecent) {
    return '=== COMB RECALL ===\n\nNo memory backend wired. Fresh start.';
  }

  const entries = _vdbRecent('comb', 12);
  if (entries.length === 0) {
    return '=== COMB RECALL ===\n\nNo staged memories found. Fresh start.';
  }

  // Sort chronologically (oldest first for reading flow)
  entries.sort((a, b) => a.timestamp - b.timestamp);

  const lines: string[] = [
    '=== COMB RECALL — Historical Notes ===',
    'These are stored notes, not live system state. They may be stale, incomplete, or from another session. Never present claims in these notes as current facts without checking the relevant live tool or file. In particular, verify process/service status, file existence, tool availability, and provider quota at the time of the question.',
    '',
  ];

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const date = new Date(entry.timestamp).toISOString().slice(0, 10);
    const preview = entry.text.length > 600 ? entry.text.slice(0, 600) + ' [...]' : entry.text;
    lines.push(`[${date} ${time}] ${preview}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Flush Messages (shutdown path) ───────────────────────────────────────

export function flushMessages(sessionLabel: string, messages: Array<{ role: string; content: string | any }>, tailCount = 4): void {
  const convMessages = messages.filter(m => m.role !== 'system' && m.role !== 'tool');
  const tail = convMessages.slice(-tailCount);
  if (tail.length === 0) return;

  const lines: string[] = [`[Session: ${sessionLabel}]`];
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Agent' : msg.role === 'user' ? 'Human' : msg.role;
    let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (content.length > 500) content = content.slice(0, 500) + '... [truncated]';
    lines.push(`${role}: ${content}`);
  }

  stage(lines.join('\n'), 'auto-flush');
}

// ── Tool Definitions ─────────────────────────────────────────────────────

export const combRecallTool: ToolDefinition = {
  name: 'comb_recall',
  description: 'Recall historical notes from COMB. Supply a query to similarity-match durable memories; without one, returns recent staged notes. Verify volatile facts with live tools.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional query for relevant durable memories' },
      k: { type: 'number', description: 'Maximum number of matching memories (default 12)' },
    },
    required: [],
  },
  idempotency: {
    class: 'read',
    idempotencyKey: (input) => `comb_recall:${String(input.query ?? '')}:${input.k ?? 12}`,
  },
  async execute(input) {
    try {
      return recall(input.query ? String(input.query) : undefined, Number(input.k ?? 12));
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export const combStageTool: ToolDefinition = {
  name: 'comb_stage',
  description: 'Stage key information in COMB for the next session. Persists across restarts.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Information to stage for next session' },
    },
    required: ['content'],
  },
  idempotency: {
    class: 'reversible_local',
    reverseDescription: 'To reverse, delete the staged memory or overwrite with new content. The original content is recoverable from VDB history if not explicitly purged.',
    idempotencyKey: (input) => `comb_stage:${String(input.content ?? '')}:${String(input.sessionId ?? 'main')}`,
  },
  async execute(input) {
    const content = String(input.content ?? '');
    try {
      if (!content.trim()) throw new Error('Memory content is required.');
      if (_memoryOffload) {
        const result = _memoryOffload(content, String(input.sessionId ?? 'main'), 'comb');
        return result.duplicate
          ? `Memory already stored (shard ${result.shardHash.slice(0, 12)}).`
          : `Distilled memory durably stored in JSONL, VDB, and Memograph (shard ${result.shardHash.slice(0, 12)}).`;
      }
      const indexed = stage(content, 'comb');
      return indexed
        ? `Staged ${content.length} chars into memory.`
        : 'This memory was already present.';
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export const memoryOffloadTool: ToolDefinition = {
  name: 'memory_offload',
  description: 'Persist one concise, distilled, self-contained memory to the append-only cold archive, Memograph topology, and VDB similarity index. Store durable facts, decisions, preferences, or task continuity; do not store raw transcripts, secrets, or transient status.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One coherent, concise memory summary; up to 20,000 characters' },
      sessionId: { type: 'string', description: 'Session or task identifier for provenance (defaults to main)' },
    },
    required: ['summary'],
  },
  idempotency: {
    class: 'irreversible',
    irreversibleReason: 'Durable memory is written to append-only JSONL, VDB index, and Memograph shard topology. Once stored, it cannot be undone without manual file deletion or archive purging.',
    idempotencyKey: (input) => `memory_offload:${String(input.summary ?? '')}:${String(input.sessionId ?? 'main')}`,
  },
  async execute(input) {
    try {
      if (!_memoryOffload) throw new Error('Durable memory backend is not initialized; nothing was offloaded.');
      const result = _memoryOffload(
        String(input.summary ?? ''),
        String(input.sessionId ?? 'main'),
        'agent',
      );
      return result.duplicate
        ? `Memory already stored (shard ${result.shardHash.slice(0, 12)}).`
        : `Memory durably stored in JSONL, VDB, and Memograph (shard ${result.shardHash.slice(0, 12)}).`;
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
