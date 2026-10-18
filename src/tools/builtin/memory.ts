// Symbiote — Builtin tool: memory search

import type { ToolDefinition } from '../types.js';
import { vdbSearchTool } from './memory-vdb.js';

export const memorySearchTool: ToolDefinition = {
  ...vdbSearchTool,
  name: 'memory_search',
  idempotency: {
    class: 'read',
    idempotencyKey: (input) => `memory_search:${String(input.query ?? '')}:${input.k ?? 5}:${input.source ?? ''}`,
  },
};