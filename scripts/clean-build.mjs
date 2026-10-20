import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const relativePath of ['dist', path.join('webapp', 'dist')]) {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean a path outside the build output directories: ${target}`);
  }

  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to clean a symbolic-link build output: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
