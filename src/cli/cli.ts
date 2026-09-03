/**
 * Symbiote — CLI Router
 * 
 * Subcommand dispatcher. Routes `symbiote <command>` to the right handler.
 * 
 * Commands:
 *   init        — Guided setup flow (CLI or desktop UI)
 *   start       — Start the gateway daemon
 *   stop        — Stop a running daemon
 *   restart     — Restart the daemon
 *   status      — Show daemon status + session info
 *   configure   — Edit mach6.json interactively
 *   agent       — Interactive REPL (default if no subcommand)
 *   logs        — Tail daemon logs
 *   install     — Install, build, configure, and optionally launch
 *   version     — Show version info
 *   help        — Show this help
 * 
 * Symbiote AI Gateway — Artifact Virtual
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  palette, gradient, multiGradient, banner, versionBanner,
  kvLine, ok, warn, fail, info, step, divider, box, sectionHeader,
} from './brand.js';
import { APP_VERSION, RELEASE_CODENAME } from '../meta/version.js';
import { loadConfig } from '../config/config.js';
import { configSearchPaths, preferredExistingPath } from '../runtime/platform.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(DIST_ROOT, '..');
const VERSION = APP_VERSION;

// ── Helpers ────────────────────────────────────────────────────

function getPidFile(): string {
  return path.join(process.cwd(), '.mach6.pid');
}

function getLogFile(): string {
  return path.join(process.cwd(), 'symbiote.log');
}

function getConfigPath(): string | undefined {
  const args = process.argv.slice(3);
  const configArg = args.find(a => a.startsWith('--config='));
  if (configArg) return configArg.split('=')[1];
  return preferredExistingPath(configSearchPaths());
}

function isRunning(): { running: boolean; pid?: number } {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) return { running: false };
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) return { running: false };
    // Check if process is alive
    if (process.platform === 'win32') {
      try {
        execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, { stdio: 'pipe' });
        const out = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, { stdio: 'pipe' }).toString();
        if (out.includes(`"${pid}"`)) return { running: true, pid };
        return { running: false };
      } catch { return { running: false }; }
    } else {
      try {
        process.kill(pid, 0); // signal 0 = existence check
        return { running: true, pid };
      } catch { return { running: false }; }
    }
  } catch { return { running: false }; }
}

function readConfig(): Record<string, any> | null {
  const configPath = getConfigPath();
  if (!configPath) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const stripped = raw.replace(
      /"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm,
      (match) => match.startsWith('"') ? match : ''
    );
    return JSON.parse(stripped);
  } catch { return null; }
}

// ── Commands ───────────────────────────────────────────────────

async function cmdHelp() {
  console.log();
  console.log(versionBanner(VERSION));
  
  const title = gradient('COMMANDS', [138, 43, 226], [0, 229, 255]);
  console.log(`  ${palette.bold}${title}${palette.reset}`);
  console.log();

  const commands: [string, string][] = [
    ['init',       'Guided setup flow — CLI or desktop UI'],
    ['start',      'Start the gateway daemon (background)'],
    ['stop',       'Stop the running daemon'],
    ['restart',    'Restart the daemon'],
    ['status',     'Show daemon status, provider, channels'],
    ['configure',  'Edit configuration interactively'],
    ['agent',      'Interactive REPL session (default)'],
    ['logs',       'Tail daemon output logs'],
    ['install',    'Install, build, configure, and launch'],
    ['version',    'Show version information'],
    ['help',       'Show this help'],
  ];

  for (const [cmd, desc] of commands) {
    const paddedCmd = cmd.padEnd(14);
    console.log(`  ${palette.cyan}${paddedCmd}${palette.reset}${palette.silver}${desc}${palette.reset}`);
  }

  console.log();
  console.log(`  ${palette.dim}Usage:${palette.reset}  symbiote ${palette.cyan}<command>${palette.reset} ${palette.dim}[options]${palette.reset}`);
  console.log(`  ${palette.dim}REPL:${palette.reset}   symbiote ${palette.dim}(no args — starts interactive agent)${palette.reset}`);
  console.log(`  ${palette.dim}One-shot:${palette.reset} symbiote agent ${palette.cyan}"your question here"${palette.reset}`);
  console.log();
  console.log(`  ${palette.dim}Options:${palette.reset}`);
  console.log(`    ${palette.cyan}--config=${palette.reset}${palette.silver}<path>${palette.reset}      Path to mach6.json`);
  console.log(`    ${palette.cyan}--provider=${palette.reset}${palette.silver}<name>${palette.reset}    Override default provider`);
  console.log(`    ${palette.cyan}--model=${palette.reset}${palette.silver}<name>${palette.reset}       Override default model`);
  console.log(`    ${palette.cyan}--session=${palette.reset}${palette.silver}<id>${palette.reset}       Use specific session`);
  console.log();
  console.log(divider());
  console.log();
}

async function cmdVersion() {
  console.log();
  console.log(versionBanner(VERSION));
  
  console.log(kvLine('Version', `${palette.cyan}${VERSION}${palette.reset}`));
  console.log(kvLine('Codename', `${palette.violet}${RELEASE_CODENAME}${palette.reset}`));
  console.log(kvLine('Node', `${palette.green}${process.version}${palette.reset}`));
  console.log(kvLine('Platform', `${palette.silver}${process.platform} ${process.arch}${palette.reset}`));
  console.log(kvLine('Install root', `${palette.dim}${PROJECT_ROOT}${palette.reset}`));
  
  const configPath = getConfigPath();
  console.log(kvLine('Config', configPath
    ? `${palette.green}${configPath}${palette.reset}`
    : `${palette.dim}not found${palette.reset}`));
  console.log();
}

async function cmdInstall() {
  console.log();
  console.log(versionBanner(VERSION));

  const args = process.argv.slice(3);
  const useUi = args.includes('--ui');
  const skipSetup = args.includes('--skip-setup');
  const noStart = args.includes('--no-start');

  const title = gradient('INSTALL', [255, 193, 37], [255, 160, 0]);
  console.log(`  ${palette.bold}${title}${palette.reset}`);
  console.log();

  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  if (nodeMajor < 20) {
    console.log(fail(`Node.js ${process.version} — requires ≥ 20.x`));
    console.log();
    return;
  }
  console.log(ok(`Node.js ${process.version}`));

  try {
    const npmVer = execSync('npm --version', { stdio: 'pipe' }).toString().trim();
    console.log(ok(`npm ${npmVer}`));
  } catch {
    console.log(fail('npm not found'));
    console.log();
    return;
  }

  try {
    const gitVer = execSync('git --version', { stdio: 'pipe' }).toString().trim();
    console.log(ok(gitVer));
  } catch {
    console.log(warn('Git not found — source updates will not be available from this machine.'));
  }

  const nodeModules = path.join(PROJECT_ROOT, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    console.log(info('Installing npm dependencies...'));
    execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  } else {
    console.log(ok('Dependencies already installed'));
  }

  console.log(info('Building distribution...'));
  execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  console.log(ok('Build complete'));

  const configPath = path.join(process.cwd(), 'mach6.json');
  const envPath = path.join(process.cwd(), '.env');

  if (!skipSetup) {
    if (useUi) {
      const { startInstallerUi } = await import('./installer-ui.js');
      await startInstallerUi();
      console.log(info('Installer UI opened in your browser. Leave this window open until setup is saved.'));
      console.log();
      return;
    }
    const { runInteractiveSetup } = await import('./setup.js');
    await runInteractiveSetup(configPath, envPath);
  } else if (!fs.existsSync(configPath)) {
    console.log(warn('No mach6.json found. Re-run without --skip-setup to create one.'));
    console.log();
    return;
  }

  if (noStart) {
    console.log(ok('Install completed. Start Symbiote with `symbiote start`.'));
    console.log();
    return;
  }

  const config = loadConfig(configPath);
  if (config.whatsapp?.enabled) {
    console.log(info('Starting Symbiote in the foreground so you can scan the WhatsApp QR code...'));
    console.log();
    const { startGateway } = await import('../gateway/daemon.js');
    await startGateway(configPath);
    return;
  }

  await cmdStart();
}

async function cmdStart() {
  console.log();
  
  const { running, pid } = isRunning();
  if (running) {
    console.log(warn(`Daemon is already running (PID: ${pid})`));
    console.log(info(`Use ${palette.cyan}symbiote restart${palette.reset} to restart.`));
    console.log();
    return;
  }

  const configPath = getConfigPath();
  if (!configPath) {
    console.log(fail('No mach6.json found. Run mach6 init first.'));
    console.log();
    return;
  }

  console.log(info('Starting Symbiote daemon...'));
  
  const daemonPath = path.join(DIST_ROOT, 'gateway', 'daemon.js');
  const logFile = getLogFile();
  const logFd = fs.openSync(logFile, 'a');
  
  const child = spawn('node', [daemonPath, `--config=${configPath}`], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  // Write PID file
  fs.writeFileSync(getPidFile(), String(child.pid));
  child.unref();
  fs.closeSync(logFd);

  // Wait a moment and verify
  await new Promise(r => setTimeout(r, 2000));
  const check = isRunning();
  
  if (check.running) {
    console.log(ok(`Daemon started (PID: ${check.pid})`));
    console.log(info(`Logs: ${palette.dim}${logFile}${palette.reset}`));
    console.log(info(`Stop: ${palette.cyan}symbiote stop${palette.reset}`));
  } else {
    console.log(fail('Daemon failed to start. Check logs:'));
    console.log(info(`  ${palette.dim}symbiote logs${palette.reset}`));
    // Clean up stale PID file
    try { fs.unlinkSync(getPidFile()); } catch {}
  }
  console.log();
}

async function cmdStop() {
  console.log();

  const { running, pid } = isRunning();
  if (!running) {
    console.log(info('No daemon running.'));
    try { fs.unlinkSync(getPidFile()); } catch {}
    console.log();
    return;
  }

  console.log(info(`Stopping daemon (PID: ${pid})...`));

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'pipe' });
    } else {
      process.kill(pid!, 'SIGTERM');
      // Give it 5 seconds then SIGKILL
      await new Promise(r => setTimeout(r, 3000));
      try { process.kill(pid!, 0); process.kill(pid!, 'SIGKILL'); } catch {}
    }
    console.log(ok('Daemon stopped.'));
  } catch (err) {
    console.log(warn(`Could not stop PID ${pid}: ${err instanceof Error ? err.message : err}`));
  }

  try { fs.unlinkSync(getPidFile()); } catch {}
  console.log();
}

async function cmdRestart() {
  await cmdStop();
  await cmdStart();
}

async function cmdStatus() {
  console.log();
  console.log(versionBanner(VERSION));

  const title = gradient('STATUS', [138, 43, 226], [0, 229, 255]);
  console.log(`  ${palette.bold}${title}${palette.reset}`);
  console.log();

  // Daemon status
  const { running, pid } = isRunning();
  if (running) {
    console.log(kvLine('Daemon', `${palette.green}● RUNNING${palette.reset} ${palette.dim}(PID: ${pid})${palette.reset}`));
  } else {
    console.log(kvLine('Daemon', `${palette.red}○ STOPPED${palette.reset}`));
  }

  // Config
  const configPath = getConfigPath();
  if (configPath) {
    console.log(kvLine('Config', `${palette.green}${configPath}${palette.reset}`));
    const config = readConfig();
    if (config) {
      console.log(kvLine('Provider', `${palette.cyan}${config.defaultProvider ?? '—'}${palette.reset}${palette.dim}/${palette.reset}${palette.white}${config.defaultModel ?? '—'}${palette.reset}`));
      
      // Channels
      const channels: string[] = [];
      if (config.discord?.token || process.env.DISCORD_BOT_TOKEN) channels.push(`${palette.cyan}Discord${palette.reset}`);
      if (config.whatsapp?.enabled) channels.push(`${palette.green}WhatsApp${palette.reset}`);
      if (channels.length === 0) channels.push(`${palette.dim}none${palette.reset}`);
      console.log(kvLine('Channels', channels.join(', ')));

      // Workspace
      console.log(kvLine('Workspace', `${palette.dim}${config.workspace ?? process.cwd()}${palette.reset}`));
    }
  } else {
    console.log(kvLine('Config', `${palette.red}not found${palette.reset}`));
  }

  // Sessions
  const sessionsDir = path.join(process.cwd(), '.sessions');
  if (fs.existsSync(sessionsDir)) {
    const sessions = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    console.log(kvLine('Sessions', `${palette.white}${sessions.length}${palette.reset} ${palette.dim}saved${palette.reset}`));
  }

  // Log file
  const logFile = getLogFile();
  if (fs.existsSync(logFile)) {
    const stats = fs.statSync(logFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(kvLine('Log', `${palette.dim}${logFile} (${sizeMB}MB)${palette.reset}`));
  }

  // PID file
  const pidFile = getPidFile();
  if (!running && fs.existsSync(pidFile)) {
    console.log(warn('Stale PID file found — daemon may have crashed.'));
    console.log(info(`  Remove: ${palette.dim}rm ${pidFile}${palette.reset}`));
  }

  console.log();
}

async function cmdConfigure() {
  console.log();
  console.log(versionBanner(VERSION));

  const configPath = getConfigPath();
  if (!configPath) {
    console.log(fail('No mach6.json found. Run mach6 init to create one.'));
    console.log();
    return;
  }

  const config = readConfig();
  if (!config) {
    console.log(fail(`Could not parse ${configPath}`));
    console.log();
    return;
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def?: string): Promise<string> =>
    new Promise(r => rl.question(`  ${palette.cyan}${q}${palette.reset}${def ? ` ${palette.dim}(${def})${palette.reset}` : ''}: `, a => r(a.trim() || def || '')));

  const title = gradient('CONFIGURE', [255, 193, 37], [255, 160, 0]);
  console.log(`  ${palette.bold}${title}${palette.reset}`);
  console.log(`  ${palette.dim}Press Enter to keep current value${palette.reset}`);
  console.log();

  // Provider
  const providers = ['anthropic', 'github-copilot', 'openai', 'ollama', 'groq', 'gladius', 'nvidia', 'gemini', 'xai'];
  console.log(`  ${palette.dim}Available providers: ${providers.join(', ')}${palette.reset}`);
  const provider = await ask('Default provider', config.defaultProvider);
  config.defaultProvider = provider;

  // Model
  const model = await ask('Default model', config.defaultModel);
  config.defaultModel = model;

  // Max tokens
  const maxTokens = await ask('Max tokens', String(config.maxTokens ?? 8192));
  config.maxTokens = parseInt(maxTokens, 10) || 8192;

  // Temperature
  const temp = await ask('Temperature', String(config.temperature ?? 0.7));
  config.temperature = parseFloat(temp) || 0.7;

  // Max iterations
  const maxIter = await ask('Max iterations per turn', String(config.maxIterations ?? 50));
  config.maxIterations = parseInt(maxIter, 10) || 50;

  // API Key for current provider
  if (provider === 'anthropic') {
    const hasKey = !!process.env.ANTHROPIC_API_KEY || !!config.providers?.anthropic?.apiKey;
    if (!hasKey) {
      const key = await ask('Anthropic API key');
      if (key) {
        config.providers = config.providers || {};
        config.providers.anthropic = { ...config.providers.anthropic, apiKey: key };
      }
    } else {
      console.log(info('  Anthropic key: already configured'));
    }
  } else if (provider === 'groq') {
    const hasKey = !!process.env.GROQ_API_KEY || !!config.providers?.groq?.apiKey;
    if (!hasKey) {
      const key = await ask('Groq API key');
      if (key) {
        config.providers = config.providers || {};
        config.providers.groq = { ...config.providers.groq, apiKey: key };
      }
    } else {
      console.log(info('  Groq key: already configured'));
    }
  } else if (provider === 'ollama') {
    const url = await ask('Ollama base URL', config.providers?.ollama?.baseUrl ?? 'http://localhost:11434');
    config.providers = config.providers || {};
    config.providers.ollama = { ...config.providers.ollama, baseUrl: url };
  }

  // Discord
  console.log();
  const discordEnable = await ask('Enable Discord?', config.discord?.token ? 'Y' : 'n');
  if (discordEnable.toLowerCase() === 'y') {
    const token = await ask('Discord bot token', config.discord?.token ? '***configured***' : '');
    if (token && token !== '***configured***') {
      config.discord = { ...config.discord, token };
    }
    const botId = await ask('Discord bot ID', config.discord?.botId ?? '');
    if (botId) config.discord = { ...config.discord, botId };
  }

  // WhatsApp
  const waEnable = await ask('Enable WhatsApp?', config.whatsapp?.enabled ? 'Y' : 'n');
  if (waEnable.toLowerCase() === 'y') {
    config.whatsapp = { ...config.whatsapp, enabled: true };
  } else {
    if (config.whatsapp) config.whatsapp.enabled = false;
  }

  rl.close();

  // Write
  console.log();
  const json = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, json, 'utf-8');
  console.log(ok(`Config saved: ${configPath}`));

  const { running } = isRunning();
  if (running) {
    console.log(info(`Daemon is running. ${palette.cyan}symbiote restart${palette.reset} to apply changes.`));
  }
  console.log();
}

async function cmdLogs() {
  const logFile = getLogFile();
  if (!fs.existsSync(logFile)) {
    console.log();
    console.log(info('No log file found.'));
    console.log(info(`Start the daemon first: ${palette.cyan}symbiote start${palette.reset}`));
    console.log();
    return;
  }

  const args = process.argv.slice(3);
  const follow = args.includes('-f') || args.includes('--follow');
  const lines = parseInt(args.find(a => a.startsWith('-n='))?.split('=')[1] ?? '50', 10);

  if (follow) {
    // Tail -f equivalent
    console.log(info(`Following ${logFile} (Ctrl+C to stop)...`));
    console.log();
    
    const tailCmd = process.platform === 'win32'
      ? spawn('powershell', ['-Command', `Get-Content '${logFile}' -Wait -Tail ${lines}`], { stdio: 'inherit' })
      : spawn('tail', ['-f', '-n', String(lines), logFile], { stdio: 'inherit' });
    
    await new Promise<void>((resolve) => {
      tailCmd.on('close', () => resolve());
      process.on('SIGINT', () => { tailCmd.kill(); resolve(); });
    });
  } else {
    // Just show last N lines
    const content = fs.readFileSync(logFile, 'utf-8');
    const allLines = content.split('\n');
    const tail = allLines.slice(-lines);
    console.log();
    console.log(info(`Last ${lines} lines of ${logFile}:`));
    console.log();
    console.log(tail.join('\n'));
    console.log();
  }
}

async function cmdAgent() {
  // Pass through to the existing REPL in index.ts
  // We dynamic-import the main function to avoid circular deps
  const agentModule = await import('../index.js');
  // index.ts handles its own CLI — we just need to make sure 
  // it doesn't re-route through us. It checks process.argv[2].
}

async function cmdInit() {
  const args = process.argv.slice(3);
  const useUi = args.includes('--ui') || args.includes('--desktop');
  if (useUi) {
    const { startInstallerUi } = await import('./installer-ui.js');
    await startInstallerUi();
    return;
  }
  const { runInteractiveSetup } = await import('./setup.js');
  await runInteractiveSetup();
}

// ── Router ─────────────────────────────────────────────────────

const COMMANDS: Record<string, () => Promise<void>> = {
  'help':      cmdHelp,
  '--help':    cmdHelp,
  '-h':        cmdHelp,
  'version':   cmdVersion,
  '--version': cmdVersion,
  '-v':        cmdVersion,
  'install':   cmdInstall,
  'init':      cmdInit,
  'start':     cmdStart,
  'stop':      cmdStop,
  'restart':   cmdRestart,
  'status':    cmdStatus,
  'configure': cmdConfigure,
  'config':    cmdConfigure,
  'logs':      cmdLogs,
  'log':       cmdLogs,
  'agent':     cmdAgent,
};

export async function routeCli(): Promise<boolean> {
  const subcommand = process.argv[2]?.toLowerCase();
  
  // No subcommand or unrecognized = fall through to REPL
  if (!subcommand) return false;
  
  const handler = COMMANDS[subcommand];
  if (!handler) return false;
  
  await handler();
  return true;
}
