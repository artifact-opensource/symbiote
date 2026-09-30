// Symbiote — Builtin tool: web fetch

import type { ToolDefinition } from '../types.js';

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch content from a URL and return text. Strips HTML to plain text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      maxChars: { type: 'number', description: 'Max characters to return (default 50000)' },
    },
    required: ['url'],
  },
  async execute(input) {
    const url = input.url as string;
    const maxChars = (input.maxChars as number) ?? 50_000;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Symbiote/0.1', Accept: 'text/html, text/plain, application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;

      let text = await res.text();

      // Basic HTML stripping
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('html')) {
        // Remove script/style tags and their content
        text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
        // Remove all tags
        text = text.replace(/<[^>]+>/g, ' ');
        // Decode common entities
        text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        // Collapse whitespace
        text = text.replace(/\s+/g, ' ').trim();
      }

      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n... (truncated)';
      return text;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
