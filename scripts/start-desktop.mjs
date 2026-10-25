import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rcedit from 'rcedit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 20) {
  throw new Error(`Node.js 20 or newer is required to start Symbiote; found ${process.versions.node}.`);
}
const entry = path.join(root, 'dist', 'index.js');
const desktopMain = path.join(root, 'desktop', 'main.cjs');
const buildFingerprintPath = path.join(root, 'dist', '.symbiote-build-fingerprint');
const sourceDirectories = [
  'src',
  path.join('webapp', 'src'),
  path.join('webapp', 'public'),
  'desktop',
  'assets',
];
const sourceFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  path.join('webapp', 'package.json'),
  path.join('webapp', 'package-lock.json'),
  path.join('webapp', 'tsconfig.json'),
  path.join('webapp', 'vite.config.ts'),
  path.join('webapp', 'index.html'),
  path.join('scripts', 'clean-build.mjs'),
  path.join('scripts', 'copy-runtime-assets.mjs'),
];

function collectFiles(directory, files = []) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name);
    if (item.isDirectory()) collectFiles(itemPath, files);
    else if (item.isFile()) files.push(itemPath);
  }
  return files;
}

function getBuildFingerprint() {
  const files = sourceFiles
    .filter(relativePath => fs.existsSync(path.join(root, relativePath)))
    .map(relativePath => path.join(root, relativePath));
  for (const directory of sourceDirectories) {
    const absolutePath = path.join(root, directory);
    if (fs.existsSync(absolutePath)) collectFiles(absolutePath, files);
  }

  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

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

function stopPreviousInstances() {
  if (process.platform !== 'win32') return;

  const script = path.join(root, 'scripts', 'windows', 'stop-symbiote.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Root',
    root,
  ], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not stop all previous Symbiote desktop and Gateway processes.');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function checkGateway(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/status',
      timeout: 2000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        if (response.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('Gateway readiness request timed out.')));
    request.once('error', () => resolve(null));
  });
}

function readGatewayProcessRecord(recordPath) {
  try {
    return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForGateway(port, child, recordPath, configPath, daemonPath) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The Symbiote desktop exited before the Gateway became healthy (exit ${child.exitCode}).`);
    }
    const status = await checkGateway(port);
    if (status) {
      const record = readGatewayProcessRecord(recordPath);
      if (!record || status.pid !== record.pid
        || path.resolve(record.configPath) !== configPath
        || path.resolve(record.daemonPath) !== daemonPath) {
        throw new Error(`Port ${port} returned HTTP 200, but it is not served by this launch's Gateway child.`);
      }
      return;
    }
    await wait(1000);
  }
  throw new Error(`The Gateway did not return HTTP 200 from /api/status on port ${port} within five minutes.`);
}

stopPreviousInstances();

const hasBuildSource = fs.existsSync(path.join(root, 'src', 'gateway', 'daemon.ts'))
  && fs.existsSync(path.join(root, 'tsconfig.json'));
const currentFingerprint = hasBuildSource ? getBuildFingerprint() : null;
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

const launchLog = path.join(root, '.session', 'desktop-launch.log');
fs.mkdirSync(path.dirname(launchLog), { recursive: true });
const logFd = fs.openSync(launchLog, 'w');
const configPath = path.join(root, 'symbiote.json');
const daemonPath = path.join(root, 'dist', 'gateway', 'daemon.js');
const gatewayProcessPath = path.join(root, '.session', 'desktop-gateway-process.json');
fs.rmSync(gatewayProcessPath, { force: true });
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const gatewayPort = Number(config.webPort ?? 3009);
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
  fs.closeSync(logFd);
  throw new Error(`Invalid Gateway webPort in ${configPath}: ${config.webPort}`);
}

const electronExecutable = createRequire(import.meta.url)('electron');
if (process.platform === 'win32') {
  try {
    await rcedit(electronExecutable, { icon: path.join(root, 'assets', 'biohazard_green.ico') });
  } catch (error) {
    throw new Error(
      `Could not apply the Symbiote icon to ${electronExecutable}. Close Symbiote and retry startup.`,
      { cause: error },
    );
  }
}
let child;
try {
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
  await waitForGateway(gatewayPort, child, gatewayProcessPath, configPath, daemonPath);
  child.unref();
} catch (error) {
  try {
    stopPreviousInstances();
  } catch (cleanupError) {
    error.message += ` Cleanup also failed: ${cleanupError.message}`;
  }
  throw error;
} finally {
  fs.closeSync(logFd);
}
console.log(`Symbiote is ready: desktop PID ${child.pid}, Gateway HTTP 200 on port ${gatewayPort}. Diagnostics: ${path.relative(root, launchLog)}`);
