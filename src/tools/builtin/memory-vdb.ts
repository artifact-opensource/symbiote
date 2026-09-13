// Symbiote — VDB Memory Tools
//
// Native persistent memory search powered by the embedded VDB.
// Replaces HEKTOR dependency for session-based memory.
// Zero external deps, zero RAM when idle.

import type { ToolDefinition } from '../types.js';
import { VectorDB, ingestSessions } from '../../memory/vdb.js';
import fs from 'node:fs';
import path from 'node:path';

function getWorkspace(): string {
  return process.env.MACH6_WORKSPACE ?? process.cwd();
}

// Singleton VDB per workspace
let _vdb: VectorDB | null = null;
let _vdbWs: string = '';
let _lastIngest: number = 0;

function getVDB(): VectorDB {
  const ws = getWorkspace();
  if (!_vdb || _vdbWs !== ws) {
    _vdb = new VectorDB(ws);
    _vdbWs = ws;
  }
  return _vdb;
}

/**
 * Auto-ingest sessions if not done recently (max once per 10 minutes).
 * Non-blocking — runs in background.
 */
function maybeIngest(db: VectorDB): void {
  const now = Date.now();
  if (now - _lastIngest < 10 * 60 * 1000) return;
  _lastIngest = now;

  try {
    const ws = getWorkspace();
    // Find all session directories
    const sessionDirs = [
      path.join(ws, '.sessions'),                    // primary sessions
      path.join(ws, '..', '.sessions'),              // parent workspace
    ];

    // Also check for mach6-core sessions (AVA's legacy dir)
    const coreDir = path.join(ws, 'mach6-core', '.sessions');
    if (fs.existsSync(coreDir)) sessionDirs.push(coreDir);

    let totalIndexed = 0;
    for (const dir of sessionDirs) {
      if (!fs.existsSync(dir)) continue;
      const result = ingestSessions(db, dir);
      totalIndexed += result.indexed;
    }

    if (totalIndexed > 0) {
      console.log(`[vdb] Auto-ingested ${totalIndexed} new documents from sessions`);
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
      source: { type: 'string', description: 'Filter by source: whatsapp, discord, webchat, comb (optional)', enum: ['whatsapp', 'discord', 'webchat', 'comb'] },
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
    const db = getVDB();
    const ws = getWorkspace();

    const sessionDirs: string[] = [];

    // Discover all session directories
    const candidates = [
      path.join(ws, '.sessions'),
      path.join(ws, 'mach6-core', '.sessions'),
    ];

    for (const dir of candidates) {
      if (fs.existsSync(dir)) sessionDirs.push(dir);
    }

    if (sessionDirs.length === 0) {
      return 'No session directories found.';
    }

    let totalProcessed = 0;
    let totalIndexed = 0;
    const lines: string[] = ['VDB Ingestion Report:\n'];

    for (const dir of sessionDirs) {
      const result = ingestSessions(db, dir);
      totalProcessed += result.processed;
      totalIndexed += result.indexed;
      lines.push(`  ${dir}: ${result.processed} messages processed, ${result.indexed} new indexed`);
    }

    const stats = db.stats();
    lines.push('');
    lines.push(`Total: ${totalProcessed} processed, ${totalIndexed} new`);
    lines.push(`VDB: ${stats.documentCount} documents, ${stats.termCount} terms, ${(stats.diskBytes / 1024).toFixed(0)}KB on disk`);
    lines.push(`Sources: ${JSON.stringify(stats.sources)}`);

    _lastIngest = Date.now();
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
