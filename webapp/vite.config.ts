import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const versionSource = fs.readFileSync(path.join(projectRoot, 'VERSION'), 'utf8');
const version = versionSource.match(/VERSION\[\]\s*=\s*"([^"]+)"/)?.[1];

if (!version) {
  throw new Error(`Could not read the application version from ${path.join(projectRoot, 'VERSION')}`);
}

export default defineConfig({
  plugins: [react()],
  define: {
    __SYMBIOTE_VERSION__: JSON.stringify(version),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3009',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
