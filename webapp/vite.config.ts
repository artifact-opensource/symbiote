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
    // The Three.js graph chunk is lazy-loaded and about 318 KB compressed.
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replaceAll('\\', '/');
          if (moduleId.includes('/node_modules/three/')) return 'three-vendor';
          if (/\/node_modules\/(?:3d-force-graph|three-forcegraph|3d-force-graph-vr|3d-force-graph-ar)\//.test(moduleId)) return 'force-graph-vendor';
          if (/\/node_modules\/d3-[^/]+\//.test(moduleId)) return 'd3-vendor';
          return undefined;
        },
      },
    },
  },
});
