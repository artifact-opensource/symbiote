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
let cachedBash: string | null | undefined;

export type ShellKind = 'auto' | 'powershell' | 'cmd' | 'bash';

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

/** Locate a real POSIX shell. On Windows this is Git Bash (never the WSL launcher in System32). */
export function findBash(): string | null {
  if (cachedBash !== undefined) return cachedBash;
  if (!isWindows()) return (cachedBash = 'bash');
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  const candidates = roots.filter((r): r is string => Boolean(r)).map(r => path.join(r, 'Git', 'bin', 'bash.exe'));
  const where = spawnSync('where', ['git'], { encoding: 'utf-8', windowsHide: true });
  for (const line of (where.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
    candidates.push(path.resolve(path.dirname(line), '..', 'bin', 'bash.exe'));
  }
  return (cachedBash = candidates.find(c => fs.existsSync(c)) ?? null);
}

const POSIX_SIGNAL = /(^|[\s;|&(])(ls\s+-|cat\s|grep\s|sed\s|awk\s|head\s|tail\s|wc\s|cut\s|sort\s|uniq\s|xargs\s|ps\s+(aux|-e)|chmod\s|chown\s|export\s+\w+=|rm\s+-|cp\s+-|mv\s+-|mkdir\s+-p|find\s+\S+\s+-|which\s|source\s|test\s+-|\[\[)|\$\(|&&|\|\||<<\s*['"]?\w+|\/dev\/null|2>&1|\bsudo\b/;
const POWERSHELL_SIGNAL = /\b(Get|Set|New|Remove|Start|Stop|Invoke|Select|Where|ForEach|Out|Test|Copy|Move|Write|Read|Import|Export|Add|Clear|Format|Measure|Sort|Group)-[A-Z]\w+|\$env:|\$PSVersionTable|\[System\.|\|\s*%\s*\{|\$_\b|-ErrorAction\b/;

function pickKind(command: string): Exclude<ShellKind, 'auto'> {
  if (!isWindows()) return 'bash';
  if (POWERSHELL_SIGNAL.test(command)) return 'powershell';
  if (POSIX_SIGNAL.test(command) && findBash()) return 'bash';
  return 'powershell';
}

/** POSIX utilities PowerShell lacks; defined per invocation so native PowerShell behaviour is untouched. */
const POSIX_SHIMS = String.raw`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; Remove-Item Alias:curl,Alias:wget -ErrorAction SilentlyContinue; function __n($a,$d){ $n=$d; $f=@(); for($i=0;$i -lt $a.Count;$i++){ if($a[$i] -eq '-n'){ $n=[int]$a[++$i] } elseif($a[$i] -match '^-(\d+)$'){ $n=[int]$Matches[1] } elseif($a[$i] -notmatch '^-'){ $f+=$a[$i] } }; ,@($n,$f) }; function head { $r=__n $args 10; if($r[1].Count){ Get-Content -TotalCount $r[0] -LiteralPath $r[1] } else { $input | Select-Object -First $r[0] } }; function tail { $r=__n $args 10; if($r[1].Count){ Get-Content -Tail $r[0] -LiteralPath $r[1] } else { $input | Select-Object -Last $r[0] } }; function grep { $i=$false;$v=$false;$p=$null;$f=@(); foreach($a in $args){ if($a -match '^-[a-zA-Z]+$'){ if($a -match 'i'){$i=$true}; if($a -match 'v'){$v=$true} } elseif($null -eq $p){ $p=$a } else { $f+=$a } }; $o=@{Pattern=$p; CaseSensitive=(-not $i); NotMatch=$v}; if($f.Count){ Select-String @o -Path $f | ForEach-Object { $_.ToString() } } else { $input | Select-String @o | ForEach-Object { $_.ToString() } } }; function wc { if($args -contains '-l'){ @($input).Count } else { $input | Measure-Object -Line -Word -Character } }; function which { foreach($a in $args){ (Get-Command $a -ErrorAction SilentlyContinue | Select-Object -First 1).Source } }; function touch { foreach($a in $args){ if(Test-Path -LiteralPath $a){ (Get-Item -LiteralPath $a).LastWriteTime=Get-Date } else { New-Item -ItemType File -Path $a | Out-Null } } }; function export { foreach($a in $args){ if($a -match '^(\w+)=(.*)$'){ Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] } } }; `;

/** Explain a failed command in terms the agent can act on, so a syntax slip is not mistaken for a broken tool. */
export function hintForFailure(command: string, output: string): string {
  if (!isWindows()) return '';
  if (/is not recognized as the name of a cmdlet|is not recognized as an internal or external command|A parameter cannot be found that matches parameter name/i.test(output)) {
    return findBash()
      ? '[hint: exec is working; that command used syntax this shell does not support. Retry with shell:"bash" for POSIX syntax, or use PowerShell equivalents.]'
      : '[hint: exec is working; that command used POSIX syntax in PowerShell. Use PowerShell equivalents (Get-Process, Get-Content, Select-String, Get-ChildItem), or the read/fs/hardware tools.]';
  }
  if (/&&|\|\|/.test(command) && /(ParserError|unexpected token|not a valid statement separator)/i.test(output)) {
    return '[hint: exec is working; PowerShell 5.1 does not support && or ||. Separate commands with ; or use shell:"bash".]';
  }
  return '';
}

/** Build the process invocation for a command. `kind: auto` routes POSIX-style commands to Git Bash when installed. */
export function shellCommand(command: string, login = false, kind: ShellKind = 'auto'): { file: string; args: string[] } {
  const resolved = kind === 'auto' ? pickKind(command) : kind;

  if (resolved === 'bash') {
    const bash = findBash();
    if (bash) {
      // Git Bash's ps lists only MSYS processes; -W shows real Windows ones.
      const prelude = isWindows() ? 'ps() { command ps -W; }; ' : '';
      return { file: bash, args: [login ? '-lc' : '-c', prelude + command] };
    }
  }

  if (isWindows()) {
    const file = resolved === 'cmd' ? (process.env.COMSPEC ?? 'cmd.exe') : windowsShell();
    if (/cmd(\.exe)?$/i.test(file)) return { file, args: ['/d', '/s', '/c', command] };
    return { file, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POSIX_SHIMS + command] };
  }

  return {
    file: process.env.SYMBIOTE_SHELL ?? process.env.SHELL ?? 'sh',
    args: [login ? '-lc' : '-c', command],
  };
}

/** One-line description of the execution environment, for the agent's system prompt. */
export function describeShell(): string {
  if (!isWindows()) return `exec runs commands with ${process.env.SHELL ?? 'sh'}.`;
  const bash = findBash();
  const ps = /pwsh/i.test(windowsShell()) ? 'PowerShell 7' : 'Windows PowerShell';
  return bash
    ? `Windows. exec runs ${ps} by default; POSIX-style commands (ls -la, grep, &&, $(...)) auto-run in Git Bash. Force one with exec's shell param (powershell | bash | cmd).`
    : `Windows. exec runs ${ps} with POSIX shims for head, tail, grep, wc, which, touch, ls -la, rm -rf, cp -r, mkdir -p. Use PowerShell syntax (not && chains); shell param accepts powershell | cmd.`;
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
