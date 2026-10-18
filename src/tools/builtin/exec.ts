// Symbiote — Builtin tool: exec shell commands (enhanced with background + PTY)

import { spawn } from 'node:child_process';
import { getProcessManager } from './process.js';
import { DEFAULT_EXEC_TIMEOUT_SECONDS, resolveExecTimeoutMs, type ToolDefinition } from '../types.js';
import { describeShell, hintForFailure, isWindows, killProcessTree, shellCommand, wrapPtyCommand, type ShellKind } from '../../runtime/platform.js';

export { DEFAULT_EXEC_TIMEOUT_SECONDS, resolveExecTimeoutMs };

const SHELLS: ShellKind[] = ['auto', 'powershell', 'bash', 'cmd'];

/** Convert a Windows path (C:\foo\bar) to a Git Bash path (/c/foo/bar) */
function toGitBashPath(p: string): string {
  if (!isWindows()) return p;
  // C:\path -> /c/path
  return p.replace(/^([A-Za-z]):[\/]/g, '/$1/').replace(/[\\]/g, '/');
}

/** Normalize Windows paths in a command string for Git Bash compatibility */
function normalizeCommandForBash(command: string): string {
  if (!isWindows()) return command;
  // Replace cd C:\path with cd /c/path
  return command.replace(/\bcd\s+([A-Za-z]:[\/][^\s;&|]*)/gi, (match, path) => {
    return `cd ${toGitBashPath(path)}`;
  });
}

export const execTool: ToolDefinition = {
  name: 'exec',
  description: `Execute a shell command and return its output (stdout + stderr). Set background=true to run in background (returns process ID for polling). ${describeShell()}`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (defaults to cwd)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 5; specify a longer timeout for longer foreground commands; ignored if background)' },
      background: { type: 'boolean', description: 'Run in background (returns process ID; use for long-running commands)' },
      pty: { type: 'boolean', description: 'Wrap in pseudo-TTY via script command' },
      shell: { type: 'string', enum: SHELLS, description: 'Shell to use (default auto: picks by command syntax)' },
      env: { type: 'object', description: 'Extra environment variables for this command' },
    },
    required: ['command'],
  },
  async execute(input, options) {
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
      const p = mgr.start(command, workdir, options?.sessionId, kind);
      return JSON.stringify({ processId: p.id, pid: p.pid, status: 'running' });
    }

    if (options?.signal?.aborted) return 'Error: Command aborted before it started.';
    const timeoutMs = resolveExecTimeoutMs(input.timeout);

    // PTY wrapping: use `script` to allocate a pseudo-terminal
    const actualCommand = pty ? wrapPtyCommand(command) : command;
    
    // Normalize Windows paths for Git Bash if needed
    const normalizedCommand = kind === 'bash' ? normalizeCommandForBash(actualCommand) : actualCommand;
    const shell = shellCommand(normalizedCommand, false, kind);

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      let settled = false;
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

      const finish = (output: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        resolve(output);
      };

      const onAbort = () => {
        killProcessTree(proc);
        finish(`Error: Command aborted.\n${Buffer.concat(chunks).toString('utf-8')}`);
      };
      const timer = setTimeout(() => {
        killProcessTree(proc);
        finish(`Error: Command timed out after ${timeoutMs / 1000}s\n${Buffer.concat(chunks).toString('utf-8')}`);
      }, timeoutMs);
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d));

      proc.on('close', (code) => {
        let output = Buffer.concat(chunks).toString('utf-8');
        if (output.length > 100_000) output = output.slice(0, 100_000) + '\n... (truncated)';
        if (code === 0 && output.trim().length === 0) {
          output = 'Command completed successfully (exit code 0; no output).';
        } else if (code !== 0) {
          output += `\nExit code: ${code}`;
        }
        const hint = hintForFailure(command, output);
        if (hint && !output.includes(hint)) output += `\n${hint}`;
        finish(output);
      });

      proc.on('error', (err) => {
        finish(`Error: ${err.message}`);
      });
    });
  },
};
