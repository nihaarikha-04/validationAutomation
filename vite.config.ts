import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const projectRoot = import.meta.dirname;
const src = resolve(projectRoot, 'src');

export default defineConfig({
  // Vite's root is src/, so built HTML keeps its src-relative path in dist/.
  // manifest.json therefore addresses panels as "devtools/panel/index.html".
  root: src,
  publicDir: resolve(projectRoot, 'public'),
  plugins: [react()],
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        devtools: resolve(src, 'devtools/devtools.html'),
        panel: resolve(src, 'devtools/panel/index.html'),
      },
    },
  },
  test: {
    root: projectRoot,
    environment: 'jsdom',
    setupFiles: [resolve(projectRoot, 'tests/setup.ts')],
    include: ['tests/**/*.test.ts?(x)', 'src/**/*.test.ts?(x)'],
  },
});
