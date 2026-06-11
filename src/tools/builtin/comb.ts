// Symbiote — COMB: Lossless Operational Memory
//
// Pure Node.js implementation. Zero external dependencies.
// Works for ANY agent on ANY platform — no Python, no venv, no flush.py.
//
// Architecture:
//   workspace/.comb/
//     staging/         — today's staged entries (one JSON file per day)
//     archive/         — rolled-up permanent documents (one JSON file per day)
//     state.json       — metadata (last rollup, entry count, etc.)
//
// The Python COMB (flush.py + comb-db) is the advanced version for AVA.
// This native COMB is the universal version — built into the engine.
// If the Python stack exists, it's used. Otherwise, native COMB kicks in.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../types.js';

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────────

function getWorkspace(): string {
  return process.env.MACH6_WORKSPACE ?? process.cwd();
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Python COMB Detection ────────────────────────────────────────────────

function hasPythonComb(ws: string): boolean {
  const python = path.join(ws, '.hektor-env', 'bin', 'python3');
  const flushScript = path.join(ws, '.ava-memory', 'flush.py');
  return fs.existsSync(python) && fs.existsSync(flushScript);
}

function getPython(ws: string): string {
  return path.join(ws, '.hektor-env', 'bin', 'python3');
}

function getFlushScript(ws: string): string {
  return path.join(ws, '.ava-memory', 'flush.py');
}

// ── Native COMB Store ────────────────────────────────────────────────────

interface StagingEntry {
  text: string;
  timestamp: string;
  source: string;
}

interface ArchiveDocument {
  date: string;
  content: string;
  entryCount: number;
  rolledAt: string;
}

class NativeCombStore {
  private stagingDir: string;
  private archiveDir: string;
  private stateFile: string;

  constructor(ws: string) {
    const combRoot = path.join(ws, '.comb');
    this.stagingDir = path.join(combRoot, 'staging');
    this.archiveDir = path.join(combRoot, 'archive');
    this.stateFile = path.join(combRoot, 'state.json');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
  }

  /** Stage text for later recall */
  stage(text: string, source = 'agent'): void {
    const date = today();
    const filePath = path.join(this.stagingDir, `${date}.json`);

    let entries: StagingEntry[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* new file */ }

    entries.push({
      text,
      timestamp: new Date().toISOString(),
      source,
    });

    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));

    // Auto-rollup: if > 10 entries for today, roll up
    if (entries.length > 10) {
      this.rollup(date);
    }
  }

  /** Roll up staging entries into an archive document */
  rollup(date?: string): boolean {
    const targetDate = date ?? today();
    const stagingFile = path.join(this.stagingDir, `${targetDate}.json`);

    if (!fs.existsSync(stagingFile)) return false;

    let entries: StagingEntry[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(stagingFile, 'utf-8'));
    } catch { return false; }

    if (entries.length === 0) return false;

    // Build archive content
    const content = entries.map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false });
      return `[${time}] ${e.text}`;
    }).join('\n\n');

    const doc: ArchiveDocument = {
      date: targetDate,
      content,
      entryCount: entries.length,
      rolledAt: new Date().toISOString(),
    };

    // Append to or create archive file
    const archiveFile = path.join(this.archiveDir, `${targetDate}.json`);
    let existing: ArchiveDocument[] = [];
    try {
      existing = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
      if (!Array.isArray(existing)) existing = [existing];
    } catch { /* new file */ }
    existing.push(doc);
    fs.writeFileSync(archiveFile, JSON.stringify(existing, null, 2));

    // Remove staging file (rolled up)
    fs.unlinkSync(stagingFile);

    // Update state
    this.updateState({ lastRollup: targetDate, totalArchived: (this.getState().totalArchived ?? 0) + entries.length });

    return true;
  }

  /** Recall — pull recent staged + archived context for session start */
  recall(): string {
    const lines: string[] = [
      '=== COMB RECALL — Session Continuity ===',
      '',
    ];

    // 1. Read staging (today + yesterday)
    let hasStaging = false;
    for (const date of [today(), yesterday()]) {
      const stagingFile = path.join(this.stagingDir, `${date}.json`);
      if (!fs.existsSync(stagingFile)) continue;

      try {
        const entries: StagingEntry[] = JSON.parse(fs.readFileSync(stagingFile, 'utf-8'));
        if (entries.length === 0) continue;

        hasStaging = true;
        lines.push(`--- Staged [${date}] (${entries.length} entries) ---`);
        for (const entry of entries.slice(-8)) { // Last 8 entries max
          const preview = entry.text.length > 600 ? entry.text.slice(0, 600) + ' [...]' : entry.text;
          lines.push(preview);
          lines.push('');
        }
      } catch { continue; }
    }

    // 2. Read archive (today + yesterday)
    let hasArchive = false;
    for (const date of [today(), yesterday()]) {
      const archiveFile = path.join(this.archiveDir, `${date}.json`);
      if (!fs.existsSync(archiveFile)) continue;

      try {
        let docs: ArchiveDocument[] = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
        if (!Array.isArray(docs)) docs = [docs];
        if (docs.length === 0) continue;

        hasArchive = true;
        const latest = docs[docs.length - 1];
        const preview = latest.content.length > 800 ? latest.content.slice(0, 800) + '\n[...]' : latest.content;
        lines.push(`--- Archive [${date}] (${latest.entryCount} entries) ---`);
        lines.push(preview);
        lines.push('');
      } catch { continue; }
    }

    // 3. Auto-rollup stale staging (older than yesterday)
    try {
      const stagingFiles = fs.readdirSync(this.stagingDir).filter(f => f.endsWith('.json'));
      const cutoff = yesterday();
      for (const file of stagingFiles) {
        const fileDate = file.replace('.json', '');
        if (fileDate < cutoff) {
          this.rollup(fileDate);
        }
      }
    } catch { /* non-fatal */ }

    if (!hasStaging && !hasArchive) {
      lines.push('No staged memories found. Fresh start.');
    }

    return lines.join('\n');
  }

  /** Flush session messages into COMB (called on shutdown) */
  flushMessages(sessionLabel: string, messages: Array<{ role: string; content: string | any }>, tailCount = 4): void {
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

    this.stage(lines.join('\n'), 'auto-flush');
  }

  private getState(): Record<string, any> {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  private updateState(updates: Record<string, any>): void {
    const state = { ...this.getState(), ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }
}

// ── Singleton Store (per workspace) ──────────────────────────────────────

let _nativeStore: NativeCombStore | null = null;
let _nativeStoreWs: string = '';

export function getNativeCombStore(ws?: string): NativeCombStore {
  const workspace = ws ?? getWorkspace();
  if (!_nativeStore || _nativeStoreWs !== workspace) {
    _nativeStore = new NativeCombStore(workspace);
    _nativeStoreWs = workspace;
  }
  return _nativeStore;
}

// ── Tool Definitions ─────────────────────────────────────────────────────

export const combRecallTool: ToolDefinition = {
  name: 'comb_recall',
  description: 'Recall operational memory from COMB — lossless session-to-session context that persists across restarts.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const ws = getWorkspace();

    // If Python COMB exists, use it (richer: BM25 search, chain integrity, HEKTOR integration)
    if (hasPythonComb(ws)) {
      try {
        const { stdout } = await execFileAsync(getPython(ws), [getFlushScript(ws), 'recall'], {
          encoding: 'utf-8',
          timeout: 30000,
          cwd: ws,
        });
        return stdout.trim() || 'No staged memories found.';
      } catch (err) {
        // Fall through to native COMB
        console.error(`[COMB] Python recall failed, falling back to native: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Native COMB — pure Node.js, zero dependencies
    try {
      const store = getNativeCombStore(ws);
      return store.recall();
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
    const ws = getWorkspace();

    // If Python COMB exists, use it
    if (hasPythonComb(ws)) {
      try {
        const { stdout } = await execFileAsync(getPython(ws), [getFlushScript(ws), 'stage', content], {
          encoding: 'utf-8',
          timeout: 30000,
          cwd: ws,
        });
        return stdout.trim() || 'Staged successfully.';
      } catch (err) {
        // Fall through to native COMB
        console.error(`[COMB] Python stage failed, falling back to native: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Native COMB
    try {
      const store = getNativeCombStore(ws);
      store.stage(content, 'agent');
      return `Staged ${content.length} chars into COMB.`;
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
