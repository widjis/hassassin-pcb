import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@hassassin/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@hassassin/kicad-import': fileURLToPath(new URL('./packages/kicad-import/src/index.ts', import.meta.url)),
      '@hassassin/fab': fileURLToPath(new URL('./packages/fab/src/index.ts', import.meta.url)),
      '@hassassin/tools': fileURLToPath(new URL('./packages/tools/src/index.ts', import.meta.url)),
      '@hassassin/sync': fileURLToPath(new URL('./packages/sync/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/cli/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'], setupFiles: ['./vitest.setup.ts'] },
});
