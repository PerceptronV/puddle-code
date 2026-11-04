import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { hostReleaseCapabilities, PROTOCOL_VERSION } from '@puddle/shared';
import { inspectHostRemoval } from '@puddle/shared/node/host-control';
import { removalHostFixture } from '../../helpers/removal-host.js';
import { scriptedRemovalSupervisor } from '../../helpers/removal-supervisor.js';
import { buildHostUpdateEntry } from '../../helpers/host-update-entry.js';
import { startHostControl } from '../../../src/security/control.js';
import { LeaseRegistry } from '../../../src/security/leases.js';

it('removes and reinstalls through the built CLI and selected host helper without deleting the retained release', async () => {
  const f = removalHostFixture();
  const registry = new LeaseRegistry();
  let close: (() => Promise<void>) | undefined;
  let pendingInstall: Promise<unknown> | undefined;
  try {
    const { node } = await buildHostUpdateEntry(f.release);
    const env = scriptedRemovalSupervisor(f.home, node, true);
    writeFileSync(
      join(f.release, 'HOST_CAPABILITIES.json'),
      JSON.stringify(hostReleaseCapabilities('0.4.0')),
    );
    writeFileSync(join(f.release, 'VERSION'), '0.4.0\n');
    writeFileSync(
      join(f.release, 'daemon/connector.mjs'),
      `import fs from 'node:fs'; import path from 'node:path';
const home = process.env.PUDDLE_HOME, marker = path.join(home, 'remote-disabled');
if (process.argv[2] === '--disable-all') fs.writeFileSync(marker, 'disabled');
else if (process.argv[2] !== '--verify-disabled' || !fs.existsSync(marker)) process.exit(1);
`,
    );
    const cli = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
    const invoke = (...args: string[]) =>
      promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 30_000 });
    const removed = await invoke('remove', 'daemon', '--yes');
    expect(removed.stdout + removed.stderr).toContain('runtimes retained');
    expect(inspectHostRemoval(f.home).state).toBe('removed');
    expect(existsSync(f.file)).toBe(false);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(true);
    expect(existsSync(f.release)).toBe(true);
    const installing = invoke('install', 'daemon');
    pendingInstall = installing;
    void installing.catch(() => {});
    // The fake supervisor records dispatch. A real isolated host-control endpoint
    // provides authenticated readiness; no production daemon or provider is started.
    await expect.poll(() => existsSync(join(f.home, 'starts')), { timeout: 10_000 }).toBe(true);
    close = await startHostControl(f.home, registry, () => ({
      port: 7434,
      version: { version: '0.4.0', protocol: PROTOCOL_VERSION },
    }));
    const installed = await installing;
    expect(installed.stdout + installed.stderr).toContain('v0.4.0 is ready');
    expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
    expect(readFileSync(join(f.home, 'remote-disabled'), 'utf8')).toBe('disabled');
    await invoke('install', 'daemon');
    expect(readFileSync(join(f.home, 'starts'), 'utf8')).toBe('start\n');
  } finally {
    await pendingInstall?.catch(() => {});
    await close?.();
    registry.dispose();
    f.close();
  }
});
