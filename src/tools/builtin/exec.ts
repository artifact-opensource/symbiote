// Symbiote — Builtin tool: exec shell commands (enhanced with background + PTY)

import { spawn } from 'node:child_process';
import { getProcessManager } from './process.js';
import type { ToolDefinition } from '../types.js';

export const execTool: ToolDefinition = {
  name: 'exec',
  description: 'Execute a shell command and return its output (stdout + stderr). Set background=true to run in background (returns process ID for polling).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (defaults to cwd)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 120, ignored if background)' },
      background: { type: 'boolean', description: 'Run in background (returns process ID)' },
      pty: { type: 'boolean', description: 'Wrap in pseudo-TTY via script command' },
    },
    required: ['command'],
  },
  async execute(input) {
    const command = input.command as string;
    const workdir = (input.workdir as string) ?? process.cwd();
    const background = input.background as boolean ?? false;
    const pty = input.pty as boolean ?? false;

    // Self-kill guard: prevent AVA from stopping/restarting her own service or rewriting the ava script
    const SELF_KILL_PATTERNS = [
      /systemctl\s+(stop|restart|disable)\s+symbiote/i,
      /kill\s+.*symbiote|pkill.*symbiote/i,
      />\s*.*\bsymbiote\b.*$/,
      /write.*\bsymbiote\b.*\bbin\b/i,
    ];
    for (const pat of SELF_KILL_PATTERNS) {
      if (pat.test(command)) {
        return `Error: Cannot restart/kill the gateway service from within the agent. Use the 'ava restart' CLI command from a terminal instead. This is a safety guard to prevent self-termination.`;
      }
    }

    // Background mode: delegate to process manager
    if (background) {
      const mgr = getProcessManager();
      const p = mgr.start(command, workdir);
      return JSON.stringify({ processId: p.id, pid: p.pid, status: 'running' });
    }

    const timeoutMs = ((input.timeout as number) ?? 120) * 1000;

    // PTY wrapping: use `script` to allocate a pseudo-terminal
    const actualCommand = pty
      ? `script -qec ${JSON.stringify(command)} /dev/null`
      : command;

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const proc = spawn('sh', ['-c', actualCommand], {
        cwd: workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: pty ? 'xterm-256color' : (process.env.TERM ?? 'dumb') },
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(`Error: Command timed out after ${timeoutMs / 1000}s\n${Buffer.concat(chunks).toString('utf-8')}`);
      }, timeoutMs);

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d));

      proc.on('close', (code) => {
        clearTimeout(timer);
        let output = Buffer.concat(chunks).toString('utf-8');
        if (output.length > 100_000) output = output.slice(0, 100_000) + '\n... (truncated)';
        if (code !== 0) output += `\nExit code: ${code}`;
        resolve(output);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve(`Error: ${err.message}`);
      });
    });
  },
};
