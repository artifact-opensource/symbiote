// Symbiote — Builtin tool: background process management

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '../types.js';

export interface ManagedProcess {
  id: string;
  command: string;
  workdir: string;
  pid: number;
  startedAt: number;
  proc: ChildProcess;
  output: string[];
  outputOffset: number; // how much has been read via poll
  exitCode: number | null;
  killed: boolean;
  sessionId?: string;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  start(command: string, workdir?: string, sessionId?: string): ManagedProcess {
    const id = randomUUID().slice(0, 8);
    const cwd = workdir ?? process.cwd();

    const proc = spawn('sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: false,
    });

    const managed: ManagedProcess = {
      id,
      command,
      workdir: cwd,
      pid: proc.pid ?? 0,
      startedAt: Date.now(),
      proc,
      output: [],
      outputOffset: 0,
      exitCode: null,
      killed: false,
      sessionId,
    };

    proc.stdout?.on('data', (d: Buffer) => managed.output.push(d.toString('utf-8')));
    proc.stderr?.on('data', (d: Buffer) => managed.output.push(d.toString('utf-8')));
    proc.on('close', (code) => { managed.exitCode = code; });
    proc.on('error', (err) => { managed.output.push(`Error: ${err.message}`); });

    this.processes.set(id, managed);
    return managed;
  }

  poll(id: string, _timeout?: number): { output: string; running: boolean; exitCode: number | null } | null {
    const p = this.processes.get(id);
    if (!p) return null;

    const newOutput = p.output.slice(p.outputOffset).join('');
    p.outputOffset = p.output.length;
    const running = p.exitCode === null && !p.killed;

    return { output: newOutput, running, exitCode: p.exitCode };
  }

  kill(id: string): boolean {
    const p = this.processes.get(id);
    if (!p) return false;
    p.killed = true;
    try { p.proc.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { p.proc.kill('SIGKILL'); } catch { /* */ } }, 3000);
    return true;
  }

  list(): Array<{ id: string; command: string; pid: number; running: boolean; startedAt: number; sessionId?: string }> {
    return [...this.processes.values()].map(p => ({
      id: p.id,
      command: p.command,
      pid: p.pid,
      running: p.exitCode === null && !p.killed,
      startedAt: p.startedAt,
      sessionId: p.sessionId,
    }));
  }

  /** Kill all processes for a session (cleanup on session end) */
  killSession(sessionId: string): number {
    let killed = 0;
    for (const p of this.processes.values()) {
      if (p.sessionId === sessionId && p.exitCode === null && !p.killed) {
        this.kill(p.id);
        killed++;
      }
    }
    return killed;
  }

  /** Remove completed processes older than maxAge ms */
  cleanup(maxAge = 300_000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, p] of this.processes) {
      if (p.exitCode !== null && now - p.startedAt > maxAge) {
        this.processes.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}

// Singleton for the global process manager
let _globalManager: ProcessManager | undefined;
export function getProcessManager(): ProcessManager {
  if (!_globalManager) _globalManager = new ProcessManager();
  return _globalManager;
}

// ── Tool definitions ──

export const processStartTool: ToolDefinition = {
  name: 'process_start',
  description: 'Start a command in the background. Returns a process ID for polling/killing.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run in background' },
      workdir: { type: 'string', description: 'Working directory' },
    },
    required: ['command'],
  },
  async execute(input) {
    const mgr = getProcessManager();
    const p = mgr.start(input.command as string, input.workdir as string | undefined);
    return JSON.stringify({ processId: p.id, pid: p.pid, command: p.command });
  },
};

export const processPollTool: ToolDefinition = {
  name: 'process_poll',
  description: 'Poll a background process for new output.',
  parameters: {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'Process ID from process_start' },
      timeout: { type: 'number', description: 'Max wait time in ms (optional)' },
    },
    required: ['processId'],
  },
  async execute(input) {
    const mgr = getProcessManager();
    const timeout = input.timeout as number | undefined;

    // If timeout specified, wait for output
    if (timeout && timeout > 0) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const result = mgr.poll(input.processId as string);
        if (!result) return JSON.stringify({ error: 'Unknown process ID' });
        if (result.output || !result.running) return JSON.stringify(result);
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const result = mgr.poll(input.processId as string);
    if (!result) return JSON.stringify({ error: 'Unknown process ID' });
    return JSON.stringify(result);
  },
};

export const processKillTool: ToolDefinition = {
  name: 'process_kill',
  description: 'Kill a background process.',
  parameters: {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'Process ID to kill' },
    },
    required: ['processId'],
  },
  async execute(input) {
    const mgr = getProcessManager();
    const ok = mgr.kill(input.processId as string);
    return ok ? 'Process killed' : 'Unknown process ID';
  },
};

export const processListTool: ToolDefinition = {
  name: 'process_list',
  description: 'List all background processes.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const mgr = getProcessManager();
    const procs = mgr.list();
    if (procs.length === 0) return 'No background processes running.';
    return JSON.stringify(procs, null, 2);
  },
};
