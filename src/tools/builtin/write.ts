// Symbiote — Builtin tool: write file (any path on disk)

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../types.js';
import { expandHome } from '../../runtime/platform.js';

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
  async execute(input) {
    const filePath = path.resolve(expandHome(String(input.path ?? '')));
    const content = String(input.content ?? '');
    const data = input.encoding === 'base64' ? Buffer.from(content, 'base64') : content;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (input.append === true) fs.appendFileSync(filePath, data);
      else fs.writeFileSync(filePath, data);
      return `${input.append === true ? 'Appended to' : 'Wrote'} ${fs.statSync(filePath).size} bytes: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
