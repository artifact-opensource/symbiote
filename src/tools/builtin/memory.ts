// Symbiote — Memory Search Tool
//
// Searches the embedded VDB (BM25 + TF-IDF hybrid).
// No external dependencies. No Python. No daemon.
// The VDB IS the memory system.

import { vdbSearchTool } from './memory-vdb.js';

export const memorySearchTool = {
  ...vdbSearchTool,
  name: 'memory_search',
};
