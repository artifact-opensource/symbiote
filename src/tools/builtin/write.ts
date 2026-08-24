// Symbiote — Builtin tool: write file

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '../types.js';

export const writeTool: ToolDefinition = {
  name: 'write',
  description: 'Write content to a file. Creates parent directories automatically. Overwrites if exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input) {
    let filePath = path.resolve(input.path as string);

    // Auto-copy to /tmp for restricted paths (Pain #10)
    const RESTRICTED_PREFIXES = ['/var/lib/whatsapp', '/var/run/whatsapp'];
    const isRestricted = RESTRICTED_PREFIXES.some(p => filePath.startsWith(p));
    if (isRestricted) {
      const tmpPath = path.join(os.tmpdir(), `symbiote-${Date.now()}-${path.basename(filePath)}`);
      filePath = tmpPath;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content as string);
    const stat = fs.statSync(filePath);
    return `Wrote ${stat.size} bytes to ${filePath}`;
  },
};
