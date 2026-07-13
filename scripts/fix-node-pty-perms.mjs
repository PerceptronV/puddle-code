// node-pty 1.1.0 ships darwin prebuilds whose spawn-helper loses its
// executable bit in the npm tarball; without it every pty.spawn fails with
// "posix_spawnp failed". Restore the bit after install (no-op elsewhere).
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Resolve from the daemon package — node-pty is its dependency, not the root's.
const require = createRequire(new URL('../packages/daemon/package.json', import.meta.url));
let root;
try {
  root = dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0); // node-pty not installed (e.g. filtered install)
}
for (const platform of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(root, 'prebuilds', platform, 'spawn-helper');
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    console.log(`fixed exec bit on ${helper}`);
  }
}
