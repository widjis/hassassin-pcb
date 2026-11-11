import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@hassassin/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@hassassin/kicad-import': fileURLToPath(new URL('../../packages/kicad-import/src/index.ts', import.meta.url)),
      '@hassassin/fab': fileURLToPath(new URL('../../packages/fab/src/index.ts', import.meta.url)),
      '@hassassin/tools': fileURLToPath(new URL('../../packages/tools/src/index.ts', import.meta.url)),
      '@hassassin/sync': fileURLToPath(new URL('../../packages/sync/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5178,
    strictPort: true,
    // The collaboration server (apps/server) runs on 5179 in development.
    proxy: {
      '/api': 'http://127.0.0.1:5179',
      '/ws': { target: 'ws://127.0.0.1:5179', ws: true },
    },
  },
});
