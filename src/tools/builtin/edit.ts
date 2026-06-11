// Symbiote — Builtin tool: surgical file editing

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../types.js';

export const editTool: ToolDefinition = {
  name: 'edit',
  description: 'Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use for precise, surgical edits.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      oldText: { type: 'string', description: 'Exact text to find and replace (must match exactly)' },
      newText: { type: 'string', description: 'New text to replace the old text with' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  async execute(input) {
    const filePath = path.resolve(input.path as string);
    const oldText = input.oldText as string;
    const newText = input.newText as string;

    if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

    const content = fs.readFileSync(filePath, 'utf-8');
    const idx = content.indexOf(oldText);
    if (idx === -1) {
      // Try to help: show nearby content
      const lines = content.split('\n');
      const preview = lines.slice(0, 10).join('\n');
      return `Error: oldText not found in ${filePath}. File starts with:\n${preview}`;
    }

    // Check for multiple matches
    const secondIdx = content.indexOf(oldText, idx + 1);
    if (secondIdx !== -1) {
      return `Error: oldText matches multiple locations in ${filePath}. Make the match more specific.`;
    }

    const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
    fs.writeFileSync(filePath, updated);

    const oldLines = oldText.split('\n').length;
    const newLines = newText.split('\n').length;
    return `Edited ${filePath}: replaced ${oldLines} line(s) with ${newLines} line(s)`;
  },
};
