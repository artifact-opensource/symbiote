// Symbiote — Memory Search Tool
//
// Searches the embedded VDB (BM25 + TF-IDF hybrid).
// No external dependencies. No Python. No daemon.
// The VDB IS the memory system.

import type { ToolDefinition } from '../types.js';
import { VectorDB } from '../../memory/vdb.js';

function getWorkspace(): string {
  return process.env.MACH6_WORKSPACE ?? process.cwd();
}

// Singleton VDB (shared with memory-vdb.ts via same path)
let _vdb: VectorDB | null = null;
let _vdbWs: string = '';

function getVDB(): VectorDB {
  const ws = getWorkspace();
  if (!_vdb || _vdbWs !== ws) {
    _vdb = new VectorDB(ws);
    _vdbWs = ws;
  }
  return _vdb;
}

export const memorySearchTool: ToolDefinition = {
  name: 'memory_search',
  description: 'Search enterprise memory using HEKTOR (BM25 + vector hybrid search). Returns semantically relevant results from indexed files.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      mode: { type: 'string', description: 'Search mode: bm25, vector, or hybrid (default)', enum: ['bm25', 'vector', 'hybrid'] },
      k: { type: 'number', description: 'Number of results (default 5)' },
    },
    required: ['query'],
  },
  async execute(input) {
    const query = String(input.query ?? '');
    const k = Number(input.k ?? 5);

    try {
      const db = getVDB();
      const results = db.search(query, k);

      if (results.length === 0) {
        return 'No results found. The memory index may need ingestion — try memory_ingest.';
      }

      const lines: string[] = [`Found ${results.length} results:\n`];
      for (const r of results) {
        const date = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
        const preview = r.text.length > 400 ? r.text.slice(0, 400) + '...' : r.text;
        lines.push(`[${date}] (${r.source}/${r.role}, score: ${r.score.toFixed(3)})`);
        lines.push(preview);
        lines.push('');
      }

      return lines.join('\n');
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
