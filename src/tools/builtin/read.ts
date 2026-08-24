// Symbiote — Builtin tool: read file

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../types.js';

export const readTool: ToolDefinition = {
  name: 'read',
  description: 'Read the contents of a file. Returns the text content. Use offset/limit for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read' },
      offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
      limit: { type: 'number', description: 'Max lines to read' },
    },
    required: ['path'],
  },
  async execute(input) {
    const filePath = path.resolve(input.path as string);
    if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return `Error: ${filePath} is a directory`;
    if (stat.size > 10 * 1024 * 1024) return `Error: File too large (${stat.size} bytes)`;

    let content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const offset = Math.max(0, ((input.offset as number) ?? 1) - 1);
    const limit = (input.limit as number) ?? 2000;
    const sliced = lines.slice(offset, offset + limit);
    content = sliced.join('\n');

    if (content.length > 50_000) content = content.slice(0, 50_000) + '\n... (truncated)';
    return content;
  },
};
