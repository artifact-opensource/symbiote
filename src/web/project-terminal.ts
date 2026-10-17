import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { interactiveShellCommand, killProcessTree } from '../runtime/platform.js';

const MAX_TERMINALS = 20;
const MAX_TERMINALS_PER_PROJECT = 5;
const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_INPUT_LENGTH = 20_000;

interface ProjectTerminal {
  id: string;
  projectId: string;
  process: ChildProcess;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  exitCode: number | null;
}

export interface ProjectTerminalOutput {
  output: string;
  running: boolean;
  exitCode: number | null;
  truncated: boolean;
}

export class ProjectTerminalManager {
  private readonly terminals = new Map<string, ProjectTerminal>();

  start(projectId: string, workdir: string): { terminalId: string; pid: number } {
    if (!projectId.trim() || !workdir.trim()) throw new Error('Project and workspace are required to start a terminal.');
    const active = [...this.terminals.values()].filter(terminal => terminal.exitCode === null);
    if (active.length >= MAX_TERMINALS) throw new Error(`At most ${MAX_TERMINALS} project terminals can run at once.`);
    if (active.filter(terminal => terminal.projectId === projectId).length >= MAX_TERMINALS_PER_PROJECT) {
      throw new Error(`At most ${MAX_TERMINALS_PER_PROJECT} terminals can run in one project.`);
    }
    if (!fs.statSync(workdir).isDirectory()) throw new Error('Project workspace is not a directory.');

    const shell = interactiveShellCommand();
    const child = spawn(shell.file, shell.args, {
      cwd: workdir,
      env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const terminal: ProjectTerminal = {
      id: randomUUID(),
      projectId,
      process: child,
      output: '',
      outputBytes: 0,
      outputTruncated: false,
      exitCode: null,
    };
    const append = (chunk: Buffer | string) => {
      const text = chunk.toString();
      terminal.output += text;
      terminal.outputBytes += Buffer.byteLength(text);
      while (terminal.outputBytes > MAX_BUFFER_BYTES && terminal.output.length) {
        const removed = terminal.output.slice(0, Math.max(1, Math.ceil(terminal.output.length / 8)));
        terminal.output = terminal.output.slice(removed.length);
        terminal.outputBytes -= Buffer.byteLength(removed);
        terminal.outputTruncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', error => {
      append(`\r\nTerminal error: ${error.message}\r\n`);
      terminal.exitCode = -1;
    });
    child.on('close', code => { terminal.exitCode = code ?? terminal.exitCode ?? -1; });
    this.terminals.set(terminal.id, terminal);
    return { terminalId: terminal.id, pid: child.pid ?? 0 };
  }

  write(projectId: string, terminalId: string, input: string): void {
    const terminal = this.get(projectId, terminalId);
    if (!input || input.length > MAX_INPUT_LENGTH) throw new Error(`Terminal input must contain 1–${MAX_INPUT_LENGTH} characters.`);
    if (terminal.exitCode !== null || !terminal.process.stdin?.writable) throw new Error('Project terminal is not running.');
    terminal.process.stdin.write(input);
  }

  poll(projectId: string, terminalId: string): ProjectTerminalOutput {
    const terminal = this.get(projectId, terminalId);
    const output = terminal.output;
    const truncated = terminal.outputTruncated;
    terminal.output = '';
    terminal.outputBytes = 0;
    terminal.outputTruncated = false;
    return {
      output,
      running: terminal.exitCode === null,
      exitCode: terminal.exitCode,
      truncated,
    };
  }

  async kill(projectId: string, terminalId: string): Promise<boolean> {
    const terminal = this.get(projectId, terminalId);
    const running = terminal.exitCode === null;
    if (running) await this.terminate(terminal);
    this.terminals.delete(terminalId);
    return running;
  }

  async killProject(projectId: string): Promise<number> {
    let killed = 0;
    const stopping: Promise<void>[] = [];
    for (const [id, terminal] of this.terminals) {
      if (terminal.projectId !== projectId) continue;
      if (terminal.exitCode === null) {
        stopping.push(this.terminate(terminal));
        killed++;
      }
      this.terminals.delete(id);
    }
    await Promise.all(stopping);
    return killed;
  }

  async stopAll(): Promise<void> {
    const stopping: Promise<void>[] = [];
    for (const terminal of this.terminals.values()) {
      if (terminal.exitCode === null) stopping.push(this.terminate(terminal));
    }
    await Promise.all(stopping);
    this.terminals.clear();
  }

  private terminate(terminal: ProjectTerminal): Promise<void> {
    if (terminal.exitCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, 5_000);
      timeout.unref?.();
      terminal.process.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      killProcessTree(terminal.process);
    });
  }

  private get(projectId: string, terminalId: string): ProjectTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.projectId !== projectId) throw new Error('Project terminal was not found.');
    return terminal;
  }
}
