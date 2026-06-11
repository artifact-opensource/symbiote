// Symbiote — HEKTOR memory search tool

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ToolDefinition } from '../types.js';

// Resolve paths from MACH6_WORKSPACE env var (set by daemon) or fallback to cwd
function getWorkspace(): string {
  return process.env.MACH6_WORKSPACE ?? process.cwd();
}

function getHektorStateDir(): string {
  return process.env.HEKTOR_STATE_DIR ?? `${getWorkspace()}/enterprise/.hektor-live`;
}

function getHektorScript(): string {
  const ws = getWorkspace();
  const candidates = [
    `${ws}/enterprise/.ava-memory/ava_memory_fast.py`,
    `${ws}/.ava-memory/ava_memory_fast.py`,
    '/opt/ava/symbiote/.ava/memory/ava_memory_fast.py',
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
}

function fallbackWorkspaceSearch(query: string, ws: string): string {
  try {
    const escaped = query.replace(/'/g, `'"'"'`);
    const cmd = [
      `rg -n -F --hidden --follow --max-count 20 '${escaped}' '${ws}'`,
      `--glob '!**/.git/**'`,
      `--glob '!**/node_modules/**'`,
      `--glob '!**/.hektor-env/**'`,
      `--glob '!**/dist/**'`,
      `| head -50`,
    ].join(' ');
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 15000, shell: '/bin/bash' }).trim();
    if (!out) return 'HEKTOR daemon unavailable and fallback search found no matches.';
    return `HEKTOR daemon unavailable — fallback workspace search results:\n${out}`;
  } catch {
    return 'HEKTOR daemon unavailable and fallback workspace search failed.';
  }
}

// Quick health check — if the daemon socket doesn't exist, HEKTOR is down
function hektorAlive(): boolean {
  const sockPath = `${getHektorStateDir()}/ava_daemon.sock`;
  return existsSync(sockPath);
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
    const mode = String(input.mode ?? 'hybrid');
    const k = Number(input.k ?? 5);
    const ws = getWorkspace();

    // Pre-flight: check daemon is running before wasting 15s on a timeout
    if (!hektorAlive()) {
      return fallbackWorkspaceSearch(query, ws);
    }

    try {
      const venv = `source ${ws}/.hektor-env/bin/activate`;
      const script = `HEKTOR_STATE_DIR=${getHektorStateDir()} python3 ${getHektorScript()}`;
      const cmd = `${venv} && ${script} search "${query.replace(/"/g, '\\"')}" --mode ${mode} -k ${k}`;
      const out = execSync(cmd, { encoding: 'utf-8', timeout: 15000, shell: '/bin/bash' });
      return out.trim() || 'No results found.';
    } catch (err) {
      // Detect timeout specifically (Node sets err.killed = true and err.signal = 'SIGTERM' on timeout)
      if (err instanceof Error && 'killed' in err && (err as any).killed) {
        return fallbackWorkspaceSearch(query, ws);
      }
      return fallbackWorkspaceSearch(query, ws);
    }
  },
};
