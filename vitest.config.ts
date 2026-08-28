import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    // CLI and daemon projects both exercise real subprocess, PTY and socket
    // lifecycles. A single workspace-wide cap prevents pure unit-test files in
    // sibling projects from starving those readiness probes on loaded CI hosts.
    maxWorkers: 2,
  },
});
