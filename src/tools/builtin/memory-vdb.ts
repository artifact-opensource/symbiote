// Symbiote — VDB Memory Tools
//
// Native persistent memory search powered by the embedded VDB.
// Native persistent memory search and ingestion for Symbiote sessions.
// Zero external deps, zero RAM when idle.

import type { ToolDefinition } from '../types.js';
import { getSharedVectorDB, ingestSessions, type SearchResult, type VectorDB } from '../../memory/vdb.js';
import { getSharedNeuralMemory } from '../../memory/neural-memory.js';
import { DurableMemory, resolveDurableMemoryArchive } from '../../memory/durable-memory.js';
import { resolveMemoGraphStorageDir } from '../../memory/memograph.js';
import fs from 'node:fs';
import path from 'node:path';

function getWorkspace(): string {
  return process.env.SYMBIOTE_WORKSPACE ?? process.cwd();
}

const lastIngestByWorkspace = new Map<string, number>();

function getVDB(): VectorDB {
  return getSharedVectorDB(getWorkspace());
}

function getSessionDirectories(): string[] {
  const workspace = getWorkspace();
  const workspaceSessionDir = path.join(workspace, '.sessions');
  return [...new Set([
    workspaceSessionDir,
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
  description: 'Search persistent memory using lexical BM25/TF-IDF and, when configured, dense semantic retrieval. Results preserve source provenance and can be filtered by source.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for in memory' },
      k: { type: 'number', description: 'Number of results (default 5)' },
      source: { type: 'string', description: 'Filter by source: session, whatsapp, discord, webchat, comb (optional)', enum: ['session', 'whatsapp', 'discord', 'webchat', 'comb'] },
    },
    required: ['query'],
  },
  idempotency: {
    class: 'read',
    idempotencyKey: (input) => `memory_recall:${String(input.query ?? '')}:${input.k ?? 5}:${String(input.source ?? '')}`,
  },
  async execute(input) {
    const query = String(input.query ?? '');
    const k = Number(input.k ?? 5);
    const source = input.source ? String(input.source) : undefined;
    if (!query.trim()) throw new Error('Memory search query must not be empty.');
    if (!Number.isInteger(k) || k < 1 || k > 50) throw new RangeError('Memory search result count must be an integer from 1 to 50.');

    const db = getVDB();

    // Auto-ingest new sessions in background
    maybeIngest(db);

    const filter = source ? { source } : undefined;
    const neuralMemory = getSharedNeuralMemory(getWorkspace());
    let results: SearchResult[];
    let degradedReason: string | undefined;
    if (neuralMemory) {
      const status = neuralMemory.status();
      if (status.indexedDocuments === 0 && status.corpusDocuments > 0) {
        degradedReason = status.lastError ?? 'the dense index has not been backfilled yet';
      }
      try {
        results = await neuralMemory.search(query, k, filter);
      } catch (failure) {
        degradedReason = failure instanceof Error ? failure.message : String(failure);
        console.error(`[memory] Neural search failed; lexical search is being used: ${degradedReason}`);
        results = db.search(query, k, filter);
      }
      void neuralMemory.indexMissing(64).catch(failure => {
        console.error(`[memory] Dense index backfill failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      });
    } else {
      results = db.search(query, k, filter);
    }

    if (results.length === 0) {
      return degradedReason
        ? `No relevant memories found. Dense search is unavailable (${degradedReason}); lexical search was also empty.`
        : 'No relevant memories found. The VDB may need initial ingestion — try memory_ingest first.';
    }

    const lines: string[] = [`Found ${results.length} memories:\n`];
    if (degradedReason) lines.push(`Dense search unavailable; lexical results shown. Reason: ${degradedReason}\n`);
    for (const r of results) {
      const date = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      const preview = r.text.length > 300 ? r.text.slice(0, 300) + '...' : r.text;
      const provenance = r.metadata?.sourceRef ?? r.namespace ?? r.id;
      const memoryType = r.metadata?.memoryType ?? 'unclassified';
      lines.push(`[${date}] (${r.source}/${r.role}, type=${memoryType}, ref=${provenance}, score=${r.score.toFixed(3)})`);
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
  idempotency: {
    class: 'irreversible',
    irreversibleReason: 'Ingestion writes conversation history into the persistent VDB index and durable archive. Once ingested, records cannot be selectively removed without manual archive deletion.',
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
    const neuralMemory = getSharedNeuralMemory(getWorkspace());
    if (neuralMemory) {
      try {
        const embedded = await neuralMemory.indexMissing(10_000);
        const status = neuralMemory.status();
        lines.push(`Neural memory: ${status.state}, ${status.indexedDocuments}/${status.corpusDocuments} documents embedded with ${status.model}; ${embedded} newly indexed.`);
      } catch (failure) {
        const status = neuralMemory.status();
        lines.push(`Neural memory: ${status.state}; embedding failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
    }

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
  idempotency: {
    class: 'read',
    idempotencyKey: () => 'memory_stats',
  },
  async execute() {
    const db = getVDB();
    const stats = db.stats();
    const workspace = getWorkspace();
    const durable = new DurableMemory(
      db,
      resolveDurableMemoryArchive(workspace),
      resolveMemoGraphStorageDir(workspace),
    ).stats();
    const lines = [
      `VDB Statistics:`,
      `  Documents: ${stats.documentCount}`,
      `  Terms: ${stats.termCount}`,
      `  Disk: ${(stats.diskBytes / 1024).toFixed(1)}KB`,
      `  Last indexed: ${stats.lastIndexed ? new Date(stats.lastIndexed).toISOString() : 'never'}`,
      `  Sources: ${JSON.stringify(stats.sources)}`,
      `Durable JSONL records: ${durable.archiveRecords} (${durable.archivePath})`,
      `Memograph shards: ${durable.graphShards}/${durable.verifiedShards} hash-verified (${durable.graphPath})`,
    ];
    const neuralMemory = getSharedNeuralMemory(workspace);
    if (neuralMemory) {
      const status = neuralMemory.status();
      lines.push(`Neural memory: ${status.state}, ${status.indexedDocuments}/${status.corpusDocuments} dense vectors, provider ${status.provider}, model ${status.model}, dimensions ${status.dimensions}`);
      if (status.lastError) lines.push(`Neural memory diagnostic: ${status.lastError}`);
    }
    return lines.join('\n');
  },
};
