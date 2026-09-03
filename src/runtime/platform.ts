import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = '.symbiote';
const LEGACY_APP_DIR = '.mach6';

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function appHomeDir(): string {
  return process.env.SYMBIOTE_HOME
    ?? process.env.MACH6_HOME
    ?? path.join(os.homedir(), APP_DIR);
}

export function legacyAppHomeDir(): string {
  return path.join(os.homedir(), LEGACY_APP_DIR);
}

export function appPath(...segments: string[]): string {
  return path.join(appHomeDir(), ...segments);
}

export function legacyAppPath(...segments: string[]): string {
  return path.join(legacyAppHomeDir(), ...segments);
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

export function preferredAppPath(...segments: string[]): string {
  return preferredExistingPath([
    appPath(...segments),
    legacyAppPath(...segments),
  ]) ?? appPath(...segments);
}

export function configSearchPaths(configPath?: string): string[] {
  if (configPath) return [configPath];
  return [
    path.join(process.cwd(), 'symbiote.json'),
    path.join(process.cwd(), 'mach6.json'),
    appPath('config.json'),
    legacyAppPath('config.json'),
  ];
}

export function defaultIpcKeyringPath(): string {
  const configured = process.env.IPC_KEYRING_PATH;
  if (configured) return configured;

  const candidates = [
    appPath('ipc-keyring.json'),
    legacyAppPath('ipc-keyring.json'),
    appPath('security', 'ipc-keyring.json'),
    legacyAppPath('security', 'ipc-keyring.json'),
  ];

  if (!isWindows()) candidates.push('/etc/mach6/ipc-keyring.json');

  return preferredExistingPath(candidates) ?? appPath('ipc-keyring.json');
}

export function shellCommand(command: string, login = false): { file: string; args: string[] } {
  if (isWindows()) {
    return {
      file: process.env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }

  return {
    file: process.env.SYMBIOTE_SHELL ?? process.env.SHELL ?? 'sh',
    args: [login ? '-lc' : '-c', command],
  };
}

export function wrapPtyCommand(command: string): string {
  if (isWindows()) return command;
  return `script -qec ${JSON.stringify(command)} /dev/null`;
}

export function pythonCommand(scriptPath: string): { file: string; args: string[] } {
  const override = process.env.SYMBIOTE_PYTHON ?? process.env.MACH6_PYTHON;
  if (override) return { file: override, args: [scriptPath] };
  if (isWindows()) return { file: 'py', args: ['-3', scriptPath] };
  return { file: 'python3', args: [scriptPath] };
}
