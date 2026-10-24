import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');
let freshlyBuilt = false;

const hasBuildSource = fs.existsSync(path.join(root, 'src', 'gateway', 'daemon.ts'))
  && fs.existsSync(path.join(root, 'tsconfig.json'));

if (!fs.existsSync(entry) || hasBuildSource) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  freshlyBuilt = true;
}

const launchLog = path.join(root, '.session', 'desktop-launch.log');
fs.mkdirSync(path.dirname(launchLog), { recursive: true });
const logFd = fs.openSync(launchLog, 'w');
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'start'], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ...(freshlyBuilt ? { SYMBIOTE_BUILD_READY: '1' } : {}),
      },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
} finally {
  fs.closeSync(logFd);
}
console.log(`Symbiote startup handed off; diagnostics: ${path.relative(root, launchLog)}`);
