import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const sourceDir = path.join(projectRoot, 'src', 'web');
const destinationDir = path.join(projectRoot, 'dist', 'web');

fs.mkdirSync(destinationDir, { recursive: true });
for (const filename of fs.readdirSync(sourceDir)) {
  if (!filename.endsWith('.py')) continue;
  fs.copyFileSync(path.join(sourceDir, filename), path.join(destinationDir, filename));
}
console.log('Copied Python runtime sidecars to dist/web.');
