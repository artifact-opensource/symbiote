// Symbiote — COMB: Lossless Operational Memory
//
// Thin wrappers over VDB. Zero file storage. Zero JSON. Zero rollup.
// Stage → VDB index. Recall → VDB recent query. That's it.

import type { ToolDefinition } from '../types.js';

// ── VDB Hook ─────────────────────────────────────────────────────────────

// VDB index + recent query hooks — set by daemon to avoid circular imports
let _vdbIndex: ((text: string, source: string) => void) | null = null;
let _vdbRecent: ((source: string, k: number) => Array<{ text: string; timestamp: number }>) | null = null;

export function setCombVdbHook(
  indexFn: (text: string, source: string) => void,
  recentFn?: (source: string, k: number) => Array<{ text: string; timestamp: number }>,
): void {
  _vdbIndex = indexFn;
  _vdbRecent = recentFn ?? null;
}

// ── Stage (index into VDB) ───────────────────────────────────────────────

function stage(text: string, source = 'comb'): void {
  if (!_vdbIndex) {
    // Pre-daemon-init: queue for later? No — just skip silently.
    // Daemon wires hook before any agent runs.
    return;
  }
  _vdbIndex(text, source);
}

// ── Recall (query VDB for recent comb entries) ───────────────────────────

function recall(): string {
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
    '=== COMB RECALL — Session Continuity ===',
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
  for (const msg of tail) {
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
  description: 'Recall operational memory from COMB — lossless session-to-session context that persists across restarts.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    try {
      return recall();
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
  async execute(input) {
    const content = String(input.content ?? '');
    try {
      stage(content, 'comb');
      return `Staged ${content.length} chars into memory.`;
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
