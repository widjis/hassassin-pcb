import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@hassassin/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@hassassin/kicad-import': fileURLToPath(new URL('../../packages/kicad-import/src/index.ts', import.meta.url)),
      '@hassassin/fab': fileURLToPath(new URL('../../packages/fab/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 5178, strictPort: true },
});
