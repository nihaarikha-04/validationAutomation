import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const projectRoot = import.meta.dirname;
const src = resolve(projectRoot, 'src');

/**
 * Second build pass, for the content scripts only.
 *
 * They cannot be ES modules — Chrome loads content scripts as classic scripts — so this pass
 * emits standalone files with no imports and no shared chunks. The two entries deliberately
 * share no runtime code; the bridge imports nothing at all for exactly this reason.
 *
 * Runs after the panel build and must not empty dist/.
 */
export default defineConfig({
  // The panel pass already copies public/ into dist/; without this the manifest is
  // duplicated into dist/content/.
  publicDir: false,
  build: {
    outDir: resolve(projectRoot, 'dist/content'),
    emptyOutDir: false,
    target: 'chrome120',
    rollupOptions: {
      input: {
        'debug-capture': resolve(src, 'content/debug-capture.ts'),
        bridge: resolve(src, 'content/bridge.ts'),
      },
      preserveEntrySignatures: false,
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
      },
    },
  },
});
