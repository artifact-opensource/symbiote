// Symbiote — Builtin tool: write file (any path on disk)

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../types.js';
import { resolveLocalPath } from '../../runtime/platform.js';

export const writeTool: ToolDefinition = {
  name: 'write',
  description: 'Write content to any file on disk. Creates parent directories automatically. Overwrites unless append=true. Use encoding="base64" to write binary data. Supports ~ paths.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to write to (absolute, relative, or ~/...)' },
      content: { type: 'string', description: 'Content to write' },
      append: { type: 'boolean', description: 'Append instead of overwrite' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How to interpret content (default utf8)' },
    },
    required: ['path', 'content'],
  },
  idempotency: {
    class: 'reversible_local',
    reverseDescription: 'To reverse, delete the file or restore from backup. The original content can be recovered if a backup exists.',
    idempotencyKey: (input) => `write:${String(input.path ?? '')}:${input.append === true}:${String(input.encoding ?? 'utf8')}:${String(input.content ?? '')}`,
  },
  async execute(input) {
    const filePath = resolveLocalPath(String(input.path ?? ''));
    const content = String(input.content ?? '');
    const data = input.encoding === 'base64'
      ? Buffer.from(content, 'base64')
      : Buffer.from(content, 'utf8');
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (input.append === true) fs.appendFileSync(filePath, data);
      else fs.writeFileSync(filePath, data);

      const verified = fs.readFileSync(filePath);
      const expected = input.append === true
        ? verified.subarray(verified.length - data.length)
        : verified;
      if (!expected.equals(data)) {
        throw new Error(`Post-write verification failed for ${filePath}`);
      }
      return `${input.append === true ? 'Appended to' : 'Wrote'} and verified ${verified.length} bytes: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};