// Symbiote — Builtin tool: exec shell commands (enhanced with background + PTY)

import { spawn } from 'node:child_process';
import { getProcessManager } from './process.js';
import type { ToolDefinition } from '../types.js';
import { describeShell, hintForFailure, isWindows, killProcessTree, shellCommand, wrapPtyCommand, type ShellKind } from '../../runtime/platform.js';

const SHELLS: ShellKind[] = ['auto', 'powershell', 'bash', 'cmd'];

export const execTool: ToolDefinition = {
  name: 'exec',
  description: `Execute a shell command and return its output (stdout + stderr). Set background=true to run in background (returns process ID for polling). ${describeShell()}`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (defaults to cwd)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 600, ignored if background)' },
      background: { type: 'boolean', description: 'Run in background (returns process ID)' },
      pty: { type: 'boolean', description: 'Wrap in pseudo-TTY via script command' },
      shell: { type: 'string', enum: SHELLS, description: 'Shell to use (default auto: picks by command syntax)' },
      env: { type: 'object', description: 'Extra environment variables for this command' },
    },
    required: ['command'],
  },
  async execute(input) {
    const command = input.command as string;
    const workdir = (input.workdir as string) ?? process.cwd();
    const background = input.background as boolean ?? false;
    const pty = input.pty as boolean ?? false;
    const requested = String(input.shell ?? 'auto') as ShellKind;
    const kind: ShellKind = SHELLS.includes(requested) ? requested : 'auto';
    const extraEnv = (input.env && typeof input.env === 'object' ? input.env : {}) as Record<string, string>;

    // Background mode: delegate to process manager
    if (background) {
      const mgr = getProcessManager();
      const p = mgr.start(command, workdir, undefined, kind);
      return JSON.stringify({ processId: p.id, pid: p.pid, status: 'running' });
    }

    const timeoutMs = ((input.timeout as number) ?? 600) * 1000;

    // PTY wrapping: use `script` to allocate a pseudo-terminal
    const actualCommand = pty ? wrapPtyCommand(command) : command;
    const shell = shellCommand(actualCommand, false, kind);

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const proc = spawn(shell.file, shell.args, {
        windowsHide: true,
        cwd: workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...extraEnv,
          TERM: pty && !isWindows() ? 'xterm-256color' : (process.env.TERM ?? 'dumb'),
        },
      });

      const timer = setTimeout(() => {
        killProcessTree(proc);
        resolve(`Error: Command timed out after ${timeoutMs / 1000}s\n${Buffer.concat(chunks).toString('utf-8')}`);
      }, timeoutMs);

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d));

      proc.on('close', (code) => {
        clearTimeout(timer);
        let output = Buffer.concat(chunks).toString('utf-8');
        if (output.length > 100_000) output = output.slice(0, 100_000) + '\n... (truncated)';
        if (code !== 0) {
          output += `\nExit code: ${code}`;
          const hint = hintForFailure(command, output);
          if (hint) output += `\n${hint}`;
        }
        resolve(output);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve(`Error: ${err.message}`);
      });
    });
  },
};
