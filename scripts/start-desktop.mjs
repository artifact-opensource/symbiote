import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');
let freshlyBuilt = false;

if (!fs.existsSync(entry)) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  freshlyBuilt = true;
}

const result = spawnSync(process.execPath, [entry, 'start'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(freshlyBuilt ? { SYMBIOTE_BUILD_READY: '1' } : {}),
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
