import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBuildFingerprint } from './build-fingerprint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 20) {
  throw new Error(`Node.js 20 or newer is required to start Symbiote; found ${process.versions.node}.`);
}
const entry = path.join(root, 'dist', 'index.js');
const gatewayEntry = path.join(root, 'dist', 'gateway', 'daemon.js');
const desktopMain = path.join(root, 'desktop', 'main.cjs');
const buildFingerprintPath = path.join(root, 'dist', '.symbiote-build-fingerprint');
const configPath = path.resolve(process.env.SYMBIOTE_CONFIG || path.join(root, 'symbiote.json'));

function hasBuildOutputs() {
  const requiredFiles = [
    entry,
    path.join(root, 'dist', 'gateway', 'daemon.js'),
    path.join(root, 'webapp', 'dist', 'index.html'),
    path.join(root, 'dist', 'webapp', 'dist', 'index.html'),
    path.join(root, 'desktop', 'app-icon.ico'),
  ];
  return requiredFiles.every(file => fs.existsSync(file));
}

function stopPreviousInstances(excludeGateway = false) {
  if (process.platform !== 'win32') return;

  const script = path.join(root, 'scripts', 'windows', 'stop-symbiote.ps1');
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Root',
    root,
  ];
  if (excludeGateway) args.push('-ExcludeGateway');
  const result = spawnSync('powershell.exe', args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not stop all previous Symbiote desktop and Gateway processes.');
}

function hasInstalledGatewayService() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('sc.exe', ['query', 'SymbioteGateway'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (/SERVICE_NAME:\s*SymbioteGateway/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) return true;
  if (result.status !== 0 && !/1060|does not exist as an installed service/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
    throw new Error(`Could not inspect the SymbioteGateway service: ${result.stderr || result.stdout || result.status}`);
  }
  return false;
}

let startupConfig;
if (fs.existsSync(configPath)) {
  try {
    startupConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in Symbiote configuration at ${configPath}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}
const workspace = path.resolve(path.dirname(configPath), startupConfig?.workspace || '.');
const sessionDirectory = path.join(workspace, '.sessions');

const installedGatewayService = hasInstalledGatewayService();
stopPreviousInstances(installedGatewayService);

const hasBuildSource = fs.existsSync(path.join(root, 'src', 'gateway', 'daemon.ts'))
  && fs.existsSync(path.join(root, 'tsconfig.json'));
const currentFingerprint = hasBuildSource ? getBuildFingerprint(root) : null;
let previousFingerprint = '';
try {
  previousFingerprint = fs.readFileSync(buildFingerprintPath, 'utf8').trim();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const buildRequired = !hasBuildOutputs()
  || (currentFingerprint !== null && previousFingerprint !== currentFingerprint);
if (buildRequired && hasBuildSource) {
  const buildCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const buildArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'];
  const result = spawnSync(buildCommand, buildArgs, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!hasBuildOutputs()) throw new Error('The build completed without producing all required desktop runtime files.');
  fs.writeFileSync(buildFingerprintPath, `${currentFingerprint}\n`, 'utf8');
} else if (buildRequired) {
  throw new Error('The production build is missing and its source files are unavailable; restore the source before launching Symbiote.');
}

const launchLog = path.join(sessionDirectory, 'desktop-launch.log');
fs.mkdirSync(path.dirname(launchLog), { recursive: true });
const logFd = fs.openSync(launchLog, 'w');
fs.writeSync(logFd, `${new Date().toISOString()} Symbiote launcher starting from ${root}.\n`);
const gatewayProcessPath = path.join(sessionDirectory, 'desktop-gateway-process.json');
fs.rmSync(gatewayProcessPath, { force: true });

const electronExecutable = createRequire(import.meta.url)('electron');
let gatewayChild;
let child;
try {
  if (!installedGatewayService) {
    const gatewayLogFd = fs.openSync(path.join(sessionDirectory, 'gateway.log'), 'a');
    try {
      gatewayChild = spawn(process.execPath, [gatewayEntry, `--config=${configPath}`], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', gatewayLogFd, gatewayLogFd],
        env: {
          ...process.env,
          SYMBIOTE_CONFIG: configPath,
        },
      });
      await new Promise((resolve, reject) => {
        gatewayChild.once('error', reject);
        gatewayChild.once('spawn', resolve);
      });
      gatewayChild.on('error', error => console.error('The prestarted Symbiote Gateway reported an error:', error));
      const temporaryPath = `${gatewayProcessPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify({
        pid: gatewayChild.pid,
        daemonPath: gatewayEntry,
        configPath,
        owner: 'launcher',
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, gatewayProcessPath);
      gatewayChild.unref();
      fs.writeSync(logFd, `${new Date().toISOString()} Gateway started as PID ${gatewayChild.pid}; Electron will show its startup screen while the Gateway initializes.\n`);
      console.log(`Symbiote Gateway started (PID ${gatewayChild.pid}); starting the optional desktop.`);
    } catch (error) {
      if (gatewayChild && gatewayChild.exitCode === null) gatewayChild.kill('SIGTERM');
      try {
        const record = JSON.parse(fs.readFileSync(gatewayProcessPath, 'utf8'));
        if (record.pid === gatewayChild?.pid) fs.rmSync(gatewayProcessPath, { force: true });
      } catch (recordError) {
        if (recordError.code !== 'ENOENT') throw recordError;
      }
      throw error;
    } finally {
      fs.closeSync(gatewayLogFd);
    }
  }

  child = spawn(electronExecutable, [desktopMain], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      SYMBIOTE_CONFIG: configPath,
      SYMBIOTE_GATEWAY_PROCESS_PATH: gatewayProcessPath,
      ...(hasBuildSource ? { SYMBIOTE_BUILD_READY: '1' } : {}),
    },
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  fs.appendFileSync(launchLog, `${new Date().toISOString()} Electron spawn succeeded as PID ${child.pid} using ${electronExecutable}.\n`);
  child.unref();
} finally {
  fs.closeSync(logFd);
}
console.log(`Symbiote desktop launched (PID ${child.pid}). Gateway startup is monitored by the desktop. Diagnostics: ${path.relative(root, launchLog)}`);
