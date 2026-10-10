// Symbiote — Builtin tool: read file (any path on disk; text, binary, large files, directories)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ToolDefinition } from '../types.js';
import { expandHome } from '../../runtime/platform.js';

const IN_MEMORY_LIMIT = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 50_000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function hexDump(buf: Buffer): string {
  const rows: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const chunk = buf.subarray(i, i + 16);
    const hex = [...chunk].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const ascii = [...chunk].map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return rows.join('\n');
}

async function readLines(filePath: string, offset: number, limit: number): Promise<string> {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  const out: string[] = [];
  let n = 0;
  for await (const line of rl) {
    if (n >= offset + limit) break;
    if (n >= offset) out.push(line);
    n++;
  }
  rl.close();
  return out.join('\n');
}

function listDirectory(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const rows = entries.slice(0, 500).map(e => {
    let size = '';
    if (e.isFile()) { try { size = ` ${fs.statSync(path.join(dir, e.name)).size}B`; } catch { /* unreadable */ } }
    return `${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : '-'} ${e.name}${e.isDirectory() ? '/' : ''}${size}`;
  });
  const more = entries.length > 500 ? `\n... ${entries.length - 500} more entries` : '';
  return `Directory ${dir} (${entries.length} entries)\n${rows.join('\n')}${more}`;
}

export const readTool: ToolDefinition = {
  name: 'read',
  description: 'Read any file on disk. Text files return their contents (use offset/limit for large files; files over 10MB are streamed). Directories return a listing. Binary files return a hex dump, or the full bytes with encoding="base64"/"hex". Supports ~ paths.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file or directory (absolute, relative, or ~/...)' },
      offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
      limit: { type: 'number', description: 'Max lines to read (default 2000)' },
      encoding: { type: 'string', enum: ['auto', 'utf8', 'base64', 'hex'], description: 'auto (default) detects binary; base64/hex return raw bytes (up to maxBytes)' },
      maxBytes: { type: 'number', description: 'Byte cap for base64/hex output (default 262144)' },
    },
    required: ['path'],
  },
  async execute(input) {
    const filePath = path.resolve(expandHome(String(input.path ?? '')));
    try {
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return listDirectory(filePath);

      const encoding = String(input.encoding ?? 'auto');
      const offset = Math.max(0, (Number(input.offset ?? 1) || 1) - 1);
      const limit = Math.max(1, Number(input.limit ?? 2000) || 2000);

      if (encoding === 'base64' || encoding === 'hex') {
        const maxBytes = Math.max(1, Number(input.maxBytes ?? 262_144) || 262_144);
        const fd = fs.openSync(filePath, 'r');
        try {
          const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
          fs.readSync(fd, buf, 0, buf.length, 0);
          const note = stat.size > buf.length ? `\n... (first ${buf.length} of ${stat.size} bytes)` : '';
          return buf.toString(encoding) + note;
        } finally { fs.closeSync(fd); }
      }

      const head = Buffer.alloc(Math.min(stat.size, 8000));
      if (head.length > 0) {
        const fd = fs.openSync(filePath, 'r');
        try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      }
      if (encoding === 'auto' && isBinary(head)) {
        const hint = IMAGE_EXT.test(filePath) ? ' Use the image tool to view it.' : ' Use encoding="base64" to get the bytes.';
        return `Binary file ${filePath} (${stat.size} bytes). First bytes:\n${hexDump(head.subarray(0, 256))}\n${hint}`;
      }

      let content: string;
      if (stat.size > IN_MEMORY_LIMIT) {
        content = await readLines(filePath, offset, limit);
      } else {
        content = fs.readFileSync(filePath, 'utf-8').split('\n').slice(offset, offset + limit).join('\n');
      }
      if (content.length > MAX_OUTPUT_CHARS) content = content.slice(0, MAX_OUTPUT_CHARS) + '\n... (truncated; use offset/limit to page)';
      return content;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
