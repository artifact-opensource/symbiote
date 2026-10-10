/**
 * Symbiote — CLI Router
 *
 * `symbiote <command>` dispatcher. No command (or an unknown one) falls through to the interactive agent.
 * Output is deliberately terse: one line per action, detail only on failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
      ['start | stop | restart', 'manage the background daemon'],
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

  if (loadConfig(configPath).whatsapp?.enabled) {
    console.log(info('Starting in the foreground so you can scan the WhatsApp QR code.'));
    const { startGateway } = await import('../gateway/daemon.js');
    await startGateway(configPath);
    return;
  }
  await cmdStart();
}

async function cmdStart() {
  const { running, pid } = isRunning();
  if (running) {
    console.log(warn(`Already running (pid ${pid}). Use ${cmd('symbiote restart')}.`));
    return;
  }

  const configPath = getConfigPath();
  if (!configPath) {
    console.log(fail(`No symbiote.json found. Run ${cmd('symbiote init')}.`));
    return;
  }

  const logFd = fs.openSync(logFile(), 'a');
  const child = spawn('node', [path.join(DIST_ROOT, 'gateway', 'daemon.js'), `--config=${configPath}`], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    windowsHide: true,
  });
  fs.writeFileSync(pidFile(), String(child.pid));
  child.unref();
  fs.closeSync(logFd);

  await new Promise(r => setTimeout(r, 2000));
  const check = isRunning();
  if (check.running) {
    console.log(ok(`Started ${palette.dim}pid ${check.pid} · ${cmd('symbiote logs -f')}${palette.dim} to follow${palette.reset}`));
    if (needsUpgrade(configPath)) console.log(hint(`Config is an older format. Run ${cmd('symbiote upgrade')} to modernise it.`));
  } else {
    console.log(fail(`Daemon exited during startup. See ${cmd('symbiote logs')}.`));
    removePid();
  }
}

async function cmdStop() {
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
  await cmdStop();
  await cmdStart();
}

async function cmdStatus() {
  const { running, pid } = isRunning();
  const configPath = getConfigPath();
  const rows: string[] = [
    kv('Daemon', running ? `${palette.green}● running${palette.reset} ${palette.dim}pid ${pid}${palette.reset}` : `${palette.red}○ stopped${palette.reset}`, 11),
  ];

  if (configPath) {
    try {
      const cfg = loadConfig(configPath);
      const channels = [
        (cfg.discord?.enabled ?? !!cfg.discord?.token) && 'Discord',
        cfg.whatsapp?.enabled && 'WhatsApp',
      ].filter(Boolean).join(' · ');
      const sessionsDir = path.resolve(cfg.sessionsDir ?? '.sessions');
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
    await startInstallerUi();
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
