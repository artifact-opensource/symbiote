/**
 * Symbiote — CLI Router
 *
 * `symbiote <command>` dispatcher. No command (or an unknown one) falls through to the interactive agent.
 * Output is deliberately terse: one line per action, detail only on failure.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  palette, multiGradient, BRAND_STOPS, versionBanner, heading, hint, cmd,
  kv, ok, warn, fail, info, box,
} from './brand.js';
import { APP_VERSION, RELEASE_CODENAME } from '../meta/version.js';
import { loadConfig } from '../config/config.js';
import { configSearchPaths, preferredExistingPath } from '../runtime/platform.js';
import { needsUpgrade, readConfigFile, readEnv, upgradeConfigFile, writeEnvValues } from '../config/upgrade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(DIST_ROOT, '..');
const require = createRequire(import.meta.url);

// ── Helpers ────────────────────────────────────────────────────

const pidFile = () => path.join(process.cwd(), '.symbiote.pid');
const logFile = () => path.join(process.cwd(), 'symbiote.log');
const tidy = (p: string) => path.relative(process.cwd(), p) || p;

function getConfigPath(): string | undefined {
  const configArg = process.argv.slice(3).find(a => a.startsWith('--config='));
  return configArg ? configArg.slice('--config='.length) : preferredExistingPath(configSearchPaths());
}

function isRunning(): { running: boolean; pid?: number } {
  try {
    const pid = parseInt(fs.readFileSync(pidFile(), 'utf-8').trim(), 10);
    if (Number.isNaN(pid)) return { running: false };
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, { stdio: 'pipe' }).toString();
      return out.includes(`"${pid}"`) ? { running: true, pid } : { running: false };
    }
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

const removePid = () => { try { fs.unlinkSync(pidFile()); } catch { /* already gone */ } };

interface DesktopControlRecord {
  pid: number;
  port: number;
  token: string;
}

function readDesktopControl(configPath: string): DesktopControlRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(configPath)), '.session', 'desktop-control.json'), 'utf8')) as Partial<DesktopControlRecord>;
    if (!Number.isInteger(record.pid) || (record.pid ?? 0) < 1 || !Number.isInteger(record.port) || (record.port ?? 0) < 1
      || (record.port ?? 0) > 65_535 || typeof record.token !== 'string' || record.token.length < 32) return undefined;
    return record as DesktopControlRecord;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT' && !(error instanceof SyntaxError)) console.error('Could not read the desktop control record:', error);
    return undefined;
  }
}

function requestDesktopControl(record: DesktopControlRecord, action: 'quit' | 'focus' | 'status'): Promise<string | undefined> {
  return new Promise(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port: record.port,
      path: `/${action}`,
      method: 'POST',
      headers: { 'x-symbiote-control-token': record.token },
      timeout: 2000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        const expectedStatus = action === 'status' ? 200 : 202;
        resolve(response.statusCode === expectedStatus ? body : undefined);
      });
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(undefined);
    });
    request.once('error', () => resolve(undefined));
    request.end();
  });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run a build step quietly; surface its output only when it fails. */
function runQuiet(label: string, command: string): boolean {
  process.stdout.write(`  ${palette.violet}›${palette.reset} ${label}${palette.dim}…${palette.reset}`);
  try {
    execSync(command, { cwd: PROJECT_ROOT, stdio: 'pipe' });
    process.stdout.write(`\r\x1b[2K${ok(label)}\n`);
    return true;
  } catch (err) {
    process.stdout.write(`\r\x1b[2K${fail(`${label} failed`)}\n`);
    const output = String((err as { stderr?: Buffer; stdout?: Buffer }).stderr ?? (err as { stdout?: Buffer }).stdout ?? '').trim();
    if (output) console.log(output.split('\n').slice(-12).map(l => `    ${palette.dim}${l}${palette.reset}`).join('\n'));
    return false;
  }
}

// ── Commands ───────────────────────────────────────────────────

async function cmdHelp() {
  console.log(versionBanner(APP_VERSION));

  const groups: Array<[string, Array<[string, string]>]> = [
    ['Run', [
      ['symbiote', 'interactive agent (REPL)'],
      ['symbiote agent "…"', 'one-shot prompt'],
      ['start | stop | restart', 'open or close the Control Room and its Gateway'],
      ['status', 'daemon, model and channels at a glance'],
      ['logs [-f] [-n=50]', 'show or follow the daemon log'],
    ]],
    ['Setup', [
      ['init [--ui]', 'guided setup in the terminal or browser'],
      ['configure', 'edit common settings'],
      ['upgrade', 'migrate symbiote.json to the current format'],
      ['install', 'install, build, configure and launch'],
    ]],
  ];

  for (const [title, rows] of groups) {
    console.log(heading(title));
    for (const [name, desc] of rows) console.log(`  ${palette.cyan}${name.padEnd(24)}${palette.reset}${palette.silver}${desc}${palette.reset}`);
    console.log();
  }

  console.log(hint('Options   --config=<path>  --provider=<id>  --model=<id>  --session=<id>'));
  console.log(hint('Debug     SYMBIOTE_LOG=debug shows internal subsystem logs'));
  console.log();
}

async function cmdVersion() {
  console.log(`${multiGradient('symbiote', BRAND_STOPS)} ${palette.white}${APP_VERSION}${palette.reset} ${palette.dim}${RELEASE_CODENAME.toLowerCase()} · node ${process.version} · ${process.platform}-${process.arch}${palette.reset}`);
}

async function cmdInstall() {
  const args = process.argv.slice(3);
  console.log(versionBanner(APP_VERSION));

  if (parseInt(process.version.slice(1), 10) < 20) {
    console.log(fail(`Node.js ${process.version} found; 20 or newer is required`));
    return;
  }
  console.log(ok(`Node.js ${process.version}`));
  try {
    console.log(ok(`npm ${execSync('npm --version', { stdio: 'pipe' }).toString().trim()}`));
  } catch {
    console.log(fail('npm not found'));
    return;
  }

  if (!fs.existsSync(path.join(PROJECT_ROOT, 'node_modules')) && !runQuiet('Installing dependencies', 'npm install')) return;
  if (!runQuiet('Building', 'npm run build')) return;

  const configPath = path.join(process.cwd(), 'symbiote.json');
  const envPath = path.join(process.cwd(), '.env');

  if (!args.includes('--skip-setup')) {
    if (args.includes('--ui')) {
      const { startInstallerUi } = await import('./installer-ui.js');
      await startInstallerUi();
      console.log(info('Installer opened in your browser. Keep this window open until setup is saved.'));
      await new Promise<void>(() => {});
      return;
    }
    const { runInteractiveSetup } = await import('./setup.js');
    await runInteractiveSetup(configPath, envPath);
  } else if (!fs.existsSync(configPath)) {
    console.log(warn(`No symbiote.json yet. Run ${cmd('symbiote init')}.`));
    return;
  }

  if (args.includes('--no-start')) return;

  await cmdStart();
}

async function cmdStart() {
  const configPath = getConfigPath();
  if (!configPath) {
    console.log(fail(`No symbiote.json found. Run ${cmd('symbiote init')}.`));
    return;
  }
  const existingControl = readDesktopControl(configPath);
  if (existingControl && processIsRunning(existingControl.pid) && await requestDesktopControl(existingControl, 'focus')) {
    console.log(ok(`Symbiote Control Room is already running ${palette.dim}(pid ${existingControl.pid})${palette.reset}.`));
    return;
  }
  const desktopMain = path.join(PROJECT_ROOT, 'desktop', 'main.cjs');
  if (!fs.existsSync(desktopMain)) {
    console.log(fail(`Electron entry point is missing: ${desktopMain}`));
    return;
  }
  let electronExecutable: string;
  try {
    electronExecutable = require('electron') as string;
    if (typeof electronExecutable !== 'string' || !fs.existsSync(electronExecutable)) {
      throw new Error('The installed Electron runtime was not found.');
    }
  } catch (error) {
    console.log(fail(`Could not launch Electron: ${error instanceof Error ? error.message : String(error)}. Install desktop dependencies or launch the installed Symbiote app.`));
    return;
  }

  const absoluteConfigPath = path.resolve(configPath);
  try {
    const child = await new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
      const process = spawn(electronExecutable, [desktopMain], {
        cwd: path.dirname(absoluteConfigPath),
        detached: true,
        stdio: 'ignore',
        env: { ...globalThis.process.env, SYMBIOTE_CONFIG: absoluteConfigPath },
        windowsHide: false,
      });
      process.once('error', reject);
      process.once('spawn', () => resolve(process));
    });
    child.unref();
    console.log(ok(`Opened the Symbiote Control Room ${palette.dim}(Electron PID ${child.pid ?? 'starting'})${palette.reset}; Electron supervises the Gateway.`));
    if (needsUpgrade(configPath)) console.log(hint(`Config is an older format. Run ${cmd('symbiote upgrade')} to modernise it.`));
  } catch (error) {
    console.log(fail(`Could not start Electron: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function cmdStop() {
  const configPath = getConfigPath();
  const control = configPath ? readDesktopControl(configPath) : undefined;
  if (control && processIsRunning(control.pid)) {
    if (!await requestDesktopControl(control, 'quit')) {
      console.log(warn(`Could not contact the running Control Room (pid ${control.pid}); it was left untouched.`));
      return;
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && processIsRunning(control.pid)) await new Promise(resolve => setTimeout(resolve, 250));
    if (processIsRunning(control.pid)) {
      console.log(warn(`Electron accepted shutdown but process ${control.pid} is still running. Check the desktop app before retrying.`));
      return;
    }
    console.log(ok(`Closed the Symbiote Control Room and its supervised Gateway ${palette.dim}(pid ${control.pid})${palette.reset}.`));
    return;
  }

  const { running, pid } = isRunning();
  if (!running) {
    console.log(info('Not running.'));
    removePid();
    return;
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'pipe' });
    } else {
      process.kill(pid!, 'SIGTERM');
      await new Promise(r => setTimeout(r, 3000));
      try { process.kill(pid!, 0); process.kill(pid!, 'SIGKILL'); } catch { /* exited cleanly */ }
    }
    console.log(ok(`Stopped ${palette.dim}pid ${pid}${palette.reset}`));
  } catch (err) {
    console.log(warn(`Could not stop pid ${pid}: ${err instanceof Error ? err.message : err}`));
  }
  removePid();
}

async function cmdRestart() {
  const configPath = getConfigPath();
  const desktop = configPath ? readDesktopControl(configPath) : undefined;
  await cmdStop();
  if (desktop && processIsRunning(desktop.pid)) return;
  await cmdStart();
}

async function cmdStatus() {
  const configPath = getConfigPath();
  const legacyDaemon = isRunning();
  const desktopControl = configPath ? readDesktopControl(configPath) : undefined;
  const desktopRunning = desktopControl ? processIsRunning(desktopControl.pid) : false;
  let desktopStatus: { pid?: number; gatewayPid?: number | null } | undefined;
  if (desktopControl && desktopRunning) {
    try {
      const result = await requestDesktopControl(desktopControl, 'status');
      if (result) desktopStatus = JSON.parse(result) as { pid?: number; gatewayPid?: number | null };
    } catch {
      desktopStatus = undefined;
    }
  }
  const gatewayPid = desktopStatus?.gatewayPid ?? legacyDaemon.pid;
  const running = Number.isInteger(gatewayPid) && (desktopStatus?.gatewayPid ? true : legacyDaemon.running);
  const rows: string[] = [
    kv('Gateway', running ? `${palette.green}● running${palette.reset} ${palette.dim}pid ${gatewayPid}${palette.reset}` : `${palette.red}○ stopped${palette.reset}`, 11),
    ...(desktopRunning ? [kv('Control Room', `${palette.green}● running${palette.reset} ${palette.dim}pid ${desktopControl?.pid}${palette.reset}`, 11)] : []),
  ];

  if (configPath) {
    try {
      const cfg = loadConfig(configPath);
      const channels = [
        (cfg.discord?.enabled ?? !!cfg.discord?.token) && 'Discord',
        cfg.whatsapp?.enabled && 'WhatsApp',
      ].filter(Boolean).join(' · ');
      const sessionsDir = path.join(path.resolve(cfg.workspace), '.session');
      const sessions = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')).length : 0;
      rows.push(
        kv('Model', `${palette.cyan}${cfg.defaultProvider}${palette.reset}${palette.dim} / ${palette.reset}${palette.white}${cfg.defaultModel}${palette.reset}`, 11),
        kv('Channels', channels ? `${palette.white}${channels}${palette.reset}` : `${palette.dim}none${palette.reset}`, 11),
        kv('Sessions', `${palette.white}${sessions}${palette.reset}`, 11),
        kv('Workspace', `${palette.dim}${tidy(cfg.workspace)}${palette.reset}`, 11),
        kv('Config', `${palette.dim}${tidy(configPath)}${palette.reset}`, 11),
      );
    } catch {
      rows.push(kv('Config', `${palette.red}unreadable${palette.reset} ${palette.dim}${tidy(configPath)}${palette.reset}`, 11));
    }
  } else {
    rows.push(kv('Config', `${palette.red}not found${palette.reset} ${palette.dim}run symbiote init${palette.reset}`, 11));
  }

  console.log();
  console.log(box(rows, { title: `${palette.bold}${multiGradient(`symbiote ${APP_VERSION}`, BRAND_STOPS)}${palette.reset}`, borderColor: palette.dark }));
  if (!running && fs.existsSync(pidFile())) console.log(hint('Stale pid file: the daemon exited unexpectedly. See symbiote logs.'));
  if (configPath && needsUpgrade(configPath)) console.log(hint(`Older config format. Run ${cmd('symbiote upgrade')}.`));
  console.log();
}

async function cmdUpgrade() {
  const configPath = getConfigPath();
  if (!configPath) {
    console.log(fail(`No symbiote.json found. Run ${cmd('symbiote init')}.`));
    return;
  }
  let report;
  try {
    report = upgradeConfigFile(configPath, path.join(path.dirname(path.resolve(configPath)), '.env'));
  } catch (err) {
    console.log(fail(`Could not upgrade ${tidy(configPath)}: ${err instanceof Error ? err.message : err}`));
    return;
  }
  if (!report.changed) {
    console.log(ok('Config is already up to date.'));
    return;
  }
  console.log(ok(`Upgraded ${tidy(configPath)}`));
  for (const change of report.changes) console.log(hint(`  · ${change}`));
  if (report.secretsMoved.length) console.log(hint(`  · secrets now live in .env: ${report.secretsMoved.join(', ')}`));
  console.log(hint(`  backup: ${tidy(report.backupPath!)}`));
  if (isRunning().running) console.log(info(`Apply with ${cmd('symbiote restart')}.`));
}

async function cmdConfigure() {
  const configPath = getConfigPath();
  if (!configPath) {
    console.log(fail(`No symbiote.json found. Run ${cmd('symbiote init')}.`));
    return;
  }
  const { PROVIDERS } = await import('./setup.js');
  const { Prompter } = await import('./ui.js');
  const envPath = path.join(path.dirname(path.resolve(configPath)), '.env');

  upgradeConfigFile(configPath, envPath);
  const raw = readConfigFile(configPath);
  const env = readEnv(envPath);
  const ask = new Prompter();

  try {
    console.log(hint('Press Enter to keep the current value.'));
    ask.section('Model');
    const previousProvider = raw.defaultProvider;
    const provider = await ask.choose('Provider', PROVIDERS.map(p => ({ id: p.id, label: p.name, note: p.note })), previousProvider ?? 'openrouter');
    const choice = PROVIDERS.find(p => p.id === provider)!;
    raw.defaultProvider = provider;
    raw.defaultModel = await ask.text('Model', provider === previousProvider && raw.defaultModel ? raw.defaultModel : choice.defaultModel);
    raw.temperature = await ask.number('Temperature', raw.temperature ?? 0.7, 0, 2);
    raw.maxIterations = await ask.number('Max iterations per pass', raw.maxIterations ?? 50, 1);

    const updates: Record<string, string> = {};
    if (choice.envKey) {
      const key = await ask.secret(`${choice.name} API key`, env[choice.envKey]);
      if (key && key !== env[choice.envKey]) updates[choice.envKey] = key;
    }

    ask.section('Channels');
    raw.discord = { ...raw.discord, enabled: await ask.confirm('Discord', raw.discord?.enabled === true) };
    if (raw.discord.enabled) {
      const token = await ask.secret('  Bot token', env.DISCORD_BOT_TOKEN);
      if (token && token !== env.DISCORD_BOT_TOKEN) updates.DISCORD_BOT_TOKEN = token;
    }
    raw.whatsapp = { ...raw.whatsapp, enabled: await ask.confirm('WhatsApp', raw.whatsapp?.enabled === true) };

    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    writeEnvValues(envPath, updates);
    console.log();
    console.log(ok(`Saved ${tidy(configPath)}`));
    if (isRunning().running) console.log(info(`Apply with ${cmd('symbiote restart')}.`));
  } finally {
    ask.close();
  }
}

async function cmdLogs() {
  const file = logFile();
  if (!fs.existsSync(file)) {
    console.log(info(`No log yet. Start the daemon with ${cmd('symbiote start')}.`));
    return;
  }
  const args = process.argv.slice(3);
  const lines = parseInt(args.find(a => a.startsWith('-n='))?.split('=')[1] ?? '40', 10);

  if (args.includes('-f') || args.includes('--follow')) {
    console.log(hint(`Following ${tidy(file)} · Ctrl+C to stop`));
    const tail = process.platform === 'win32'
      ? spawn('powershell', ['-NoProfile', '-Command', `Get-Content -LiteralPath '${file}' -Wait -Tail ${lines}`], { stdio: 'inherit' })
      : spawn('tail', ['-f', '-n', String(lines), file], { stdio: 'inherit' });
    await new Promise<void>(resolve => {
      tail.on('close', () => resolve());
      process.on('SIGINT', () => { tail.kill(); resolve(); });
    });
    return;
  }
  console.log(fs.readFileSync(file, 'utf-8').split('\n').slice(-lines).join('\n'));
}

async function cmdInit() {
  const args = process.argv.slice(3);
  if (args.includes('--ui') || args.includes('--desktop')) {
    const { startInstallerUi } = await import('./installer-ui.js');
    const configDirectoryArgument = args.find(argument => argument.startsWith('--config-dir='));
    const configDirectory = configDirectoryArgument
      ? path.resolve(configDirectoryArgument.slice('--config-dir='.length))
      : path.dirname(getConfigPath() ?? path.resolve('symbiote.json'));
    await startInstallerUi(3010, configDirectory);
    await new Promise<void>(() => {});
    return;
  }
  const { runInteractiveSetup } = await import('./setup.js');
  await runInteractiveSetup(getConfigPath() ?? path.resolve('symbiote.json'));
}

// ── Router ─────────────────────────────────────────────────────

const COMMANDS: Record<string, () => Promise<void>> = {
  help: cmdHelp, '--help': cmdHelp, '-h': cmdHelp,
  version: cmdVersion, '--version': cmdVersion, '-v': cmdVersion,
  install: cmdInstall,
  init: cmdInit,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  configure: cmdConfigure, config: cmdConfigure,
  upgrade: cmdUpgrade,
  logs: cmdLogs, log: cmdLogs,
};

export async function routeCli(): Promise<boolean> {
  const subcommand = process.argv[2]?.toLowerCase();
  if (!subcommand) return false;
  const handler = COMMANDS[subcommand];
  if (!handler) return false;
  await handler();
  return true;
}
