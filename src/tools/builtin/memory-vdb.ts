// Symbiote — VDB Memory Tools
//
// Native persistent memory search powered by the embedded VDB.
// Native persistent memory search and ingestion for Symbiote sessions.
// Zero external deps, zero RAM when idle.

import type { ToolDefinition } from '../types.js';
import { getSharedVectorDB, ingestSessions, type VectorDB } from '../../memory/vdb.js';
import { loadConfig } from '../../config/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getWorkspace(): string {
  return process.env.MACH6_WORKSPACE ?? process.cwd();
}

const lastIngestByWorkspace = new Map<string, number>();

function getVDB(): VectorDB {
  return getSharedVectorDB(getWorkspace());
}

function getSessionDirectories(): string[] {
  const workspace = getWorkspace();
  const configured = process.env.SYMBIOTE_SESSIONS_DIR
    ?? process.env.MACH6_SESSIONS_DIR
    ?? loadConfig().sessionsDir
    ?? path.join(os.homedir(), '.mach6', 'sessions');
  return [...new Set([
    path.resolve(configured),
    path.join(workspace, '.sessions'),
  ])];
}

export function ingestWorkspaceSessions(): { processed: number; indexed: number } {
  const db = getVDB();
  let processed = 0;
  let indexed = 0;

  for (const dir of getSessionDirectories()) {
    if (!fs.existsSync(dir)) continue;
    const result = ingestSessions(db, dir, 'session');
    processed += result.processed;
    indexed += result.indexed;
  }

  lastIngestByWorkspace.set(getWorkspace(), Date.now());
  return { processed, indexed };
}

/**
 * Auto-ingest sessions if not done recently (max once per 10 minutes).
 * Non-blocking — runs in background.
 */
function maybeIngest(db: VectorDB): void {
  const now = Date.now();
  const workspace = getWorkspace();
  const lastIngest = lastIngestByWorkspace.get(workspace) ?? 0;
  if (now - lastIngest < 10 * 60 * 1000) return;
  lastIngestByWorkspace.set(workspace, now);

  try {
    const result = ingestWorkspaceSessions();
    if (result.indexed > 0) {
      console.log(`[vdb] Auto-ingested ${result.indexed} new documents from sessions`);
    }

    // Idle eviction check
    db.checkIdle();
  } catch (err) {
    console.error(`[vdb] Auto-ingest error: ${err instanceof Error ? err.message : err}`);
  }
}

export const vdbSearchTool: ToolDefinition = {
  name: 'memory_recall',
  description: 'Search your persistent memory — past conversations, decisions, context. Finds relevant memories from WhatsApp, Discord, webchat, and COMB entries.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for in memory' },
      k: { type: 'number', description: 'Number of results (default 5)' },
      source: { type: 'string', description: 'Filter by source: session, whatsapp, discord, webchat, comb (optional)', enum: ['session', 'whatsapp', 'discord', 'webchat', 'comb'] },
    },
    required: ['query'],
  },
  async execute(input) {
    const query = String(input.query ?? '');
    const k = Number(input.k ?? 5);
    const source = input.source ? String(input.source) : undefined;

    const db = getVDB();

    // Auto-ingest new sessions in background
    maybeIngest(db);

    const results = db.search(query, k, source ? { source } : undefined);

    if (results.length === 0) {
      return 'No relevant memories found. The VDB may need initial ingestion — try memory_ingest first.';
    }

    const lines: string[] = [`Found ${results.length} memories:\n`];
    for (const r of results) {
      const date = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      const preview = r.text.length > 300 ? r.text.slice(0, 300) + '...' : r.text;
      lines.push(`[${date}] (${r.source}/${r.role}, score: ${r.score.toFixed(3)})`);
      lines.push(preview);
      lines.push('');
    }

    return lines.join('\n');
  },
};

export const vdbIngestTool: ToolDefinition = {
  name: 'memory_ingest',
  description: 'Ingest all conversation history into persistent memory. Run once to bootstrap, then it auto-maintains.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute() {
    const sessionDirs = getSessionDirectories();
    if (!sessionDirs.some(dir => fs.existsSync(dir))) {
      return 'No session directories found.';
    }
    const { processed: totalProcessed, indexed: totalIndexed } = ingestWorkspaceSessions();
    const db = getVDB();
    const lines: string[] = ['VDB Ingestion Report:\n'];

    const stats = db.stats();
    lines.push('');
    lines.push(`Total: ${totalProcessed} processed, ${totalIndexed} new`);
    lines.push(`VDB: ${stats.documentCount} documents, ${stats.termCount} terms, ${(stats.diskBytes / 1024).toFixed(0)}KB on disk`);
    lines.push(`Sources: ${JSON.stringify(stats.sources)}`);

    return lines.join('\n');
  },
};

export const vdbStatsTool: ToolDefinition = {
  name: 'memory_stats',
  description: 'Show persistent memory database statistics.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute() {
    const db = getVDB();
    const stats = db.stats();
    return [
      `VDB Statistics:`,
      `  Documents: ${stats.documentCount}`,
      `  Terms: ${stats.termCount}`,
      `  Disk: ${(stats.diskBytes / 1024).toFixed(1)}KB`,
      `  Last indexed: ${stats.lastIndexed ? new Date(stats.lastIndexed).toISOString() : 'never'}`,
      `  Sources: ${JSON.stringify(stats.sources)}`,
    ].join('\n');
  },
};
