import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests always see shared source — never a stale dist build.
      '@puddle/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  // Tunnel/daemon suites spawn and probe real child processes. Unbounded file
  // parallelism starves those children on CI and turns readiness deadlines
  // into cascading false failures, even though each file passes in isolation.
  test: { name: 'cli', testTimeout: 20000, hookTimeout: 60000 },
});
