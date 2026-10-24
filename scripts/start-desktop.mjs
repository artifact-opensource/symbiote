import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');
const buildFingerprintPath = path.join(root, 'dist', '.symbiote-build-fingerprint');
const sourceDirectories = ['src', path.join('webapp', 'src'), path.join('webapp', 'public')];
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
  ];
  return requiredFiles.every(file => fs.existsSync(file));
}

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
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'start'], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ...(hasBuildSource ? { SYMBIOTE_BUILD_READY: '1' } : {}),
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
