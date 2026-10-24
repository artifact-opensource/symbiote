import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const sourceDir = path.join(projectRoot, 'src', 'web');
const destinationDir = path.join(projectRoot, 'dist', 'web');
const builtWebappDir = path.join(projectRoot, 'webapp', 'dist');
const bundledWebappDir = path.join(projectRoot, 'dist', 'webapp', 'dist');
const sourceIcon = path.join(projectRoot, 'assets', 'biohazard_green.ico');
const desktopIcon = path.join(projectRoot, 'desktop', 'app-icon.ico');

if (!fs.existsSync(path.join(builtWebappDir, 'index.html'))) {
  throw new Error(`Production web app build is missing: ${path.join(builtWebappDir, 'index.html')}`);
}
if (!fs.existsSync(sourceIcon)) {
  throw new Error(`The green Symbiote desktop icon is missing: ${sourceIcon}`);
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(sourceIcon, desktopIcon);
fs.writeFileSync(path.join(projectRoot, 'dist', '.npmignore'), 'windows-installer/\n');
for (const filename of fs.readdirSync(sourceDir)) {
  if (!filename.endsWith('.py')) continue;
  fs.copyFileSync(path.join(sourceDir, filename), path.join(destinationDir, filename));
}
fs.rmSync(bundledWebappDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(bundledWebappDir), { recursive: true });
fs.cpSync(builtWebappDir, bundledWebappDir, { recursive: true });
console.log('Copied Python runtime sidecars and the production web app into dist.');
