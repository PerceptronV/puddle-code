import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@puddle-code/cli/lib': fileURLToPath(new URL('../cli/src/lib/index.ts', import.meta.url)),
      '@puddle/shared/node/host-control': fileURLToPath(
        new URL('../shared/src/node/host-control.ts', import.meta.url),
      ),
      '@puddle/shared/node': fileURLToPath(
        new URL('../shared/src/node/security.ts', import.meta.url),
      ),
      '@puddle/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: { name: 'desktop' },
});
