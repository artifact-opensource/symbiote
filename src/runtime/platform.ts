import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = '.symbiote';

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Expand a leading `~` (and `~/...`) to the user's home directory.
 * Node never does this automatically — only interactive shells do — so any
 * config value like "~/.symbiote/whatsapp-auth" would otherwise be created as a
 * literal "~" folder under the current working directory on every OS,
 * Windows included (where `~` has no special meaning at all).
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || (isWindows() && p.startsWith('~\\'))) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function appHomeDir(): string {
  return process.env.SYMBIOTE_HOME ?? path.join(os.homedir(), APP_DIR);
}

export function appPath(...segments: string[]): string {
  return path.join(appHomeDir(), ...segments);
}

export function preferredExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

export function configSearchPaths(configPath?: string): string[] {
  if (configPath) return [configPath];
  return [
    path.join(process.cwd(), 'symbiote.json'),
    appPath('config.json'),
  ];
}

export function defaultIpcKeyringPath(): string {
  const configured = process.env.IPC_KEYRING_PATH;
  if (configured) return configured;

  return preferredExistingPath([
    appPath('ipc-keyring.json'),
    appPath('security', 'ipc-keyring.json'),
  ]) ?? appPath('ipc-keyring.json');
}

let cachedWindowsShell: string | undefined;

/** PowerShell gives agents a usable shell on Windows; cmd.exe is the last resort. */
function windowsShell(): string {
  if (cachedWindowsShell) return cachedWindowsShell;
  const override = process.env.SYMBIOTE_SHELL;
  if (override) return (cachedWindowsShell = override);
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true });
    if (!probe.error && probe.status === 0) return (cachedWindowsShell = candidate);
  }
  return (cachedWindowsShell = process.env.COMSPEC ?? 'cmd.exe');
}

export function shellCommand(command: string, login = false): { file: string; args: string[] } {
  if (isWindows()) {
    const file = windowsShell();
    if (/cmd(\.exe)?$/i.test(file)) return { file, args: ['/d', '/s', '/c', command] };
    const prelude = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ";
    return { file, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command] };
  }

  return {
    file: process.env.SYMBIOTE_SHELL ?? process.env.SHELL ?? 'sh',
    args: [login ? '-lc' : '-c', command],
  };
}

/** Kill a child and its whole process tree. */
export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!proc.pid) return;
  if (isWindows()) {
    spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { proc.kill(signal); } catch { /* already dead */ }
}

export function wrapPtyCommand(command: string): string {
  if (isWindows()) return command;
  return `script -qec ${JSON.stringify(command)} /dev/null`;
}

export function pythonCommand(scriptPath: string): { file: string; args: string[] } {
  const override = process.env.SYMBIOTE_PYTHON;
  if (override) return { file: override, args: [scriptPath] };
  if (isWindows()) return { file: 'py', args: ['-3', scriptPath] };
  return { file: 'python3', args: [scriptPath] };
}
