import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { hostReleaseCapabilities, PROTOCOL_VERSION } from '@puddle/shared';
import { inspectHostRemoval } from '@puddle/shared/node/host-control';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { removalHostFixture } from '../../helpers/removal-host.js';
import { scriptedRemovalSupervisor } from '../../helpers/removal-supervisor.js';
import { buildHostConnectorEntry, buildHostUpdateEntry } from '../../helpers/host-update-entry.js';
import { startHostControl } from '../../../src/security/control.js';
import { LeaseRegistry } from '../../../src/security/leases.js';

it('continues partial remote disablement, removes and reinstalls through the built CLI and real pinned helpers', async () => {
  const f = removalHostFixture();
  const registry = new LeaseRegistry();
  let close: (() => Promise<void>) | undefined;
  let pendingInstall: Promise<unknown> | undefined;
  try {
    const { node } = await buildHostUpdateEntry(f.release);
    await buildHostConnectorEntry(f.release);
    const env = scriptedRemovalSupervisor(f.home, node, true);
    writeFileSync(
      join(f.release, 'HOST_CAPABILITIES.json'),
      JSON.stringify(hostReleaseCapabilities('0.4.0')),
    );
    writeFileSync(join(f.release, 'VERSION'), '0.4.0\n');
    const profiles = ['a'.repeat(10), 'b'.repeat(10)].map((id) =>
      join(f.home, 'remote/profiles', id, 'config.json'),
    );
    const config = {
      enabled: true,
      host: crypto.randomUUID(),
      account: 'fixture',
      credential: 'a'.repeat(64),
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
    };
    for (const path of profiles) atomicPrivateJson(path, config);
    writeFileSync(profiles[1]!, '{');
    const cli = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
    const invoke = (...args: string[]) =>
      promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 30_000 });
    await expect(invoke('remove', 'daemon', '--yes')).rejects.toThrow();
    expect(inspectHostRemoval(f.home).state).toBe('removing');
    expect(readPrivateJson(profiles[0]!)).toEqual({ ...config, enabled: false });
    const firstInode = statSync(profiles[0]!).ino;
    expect(existsSync(f.file)).toBe(true);
    atomicPrivateJson(profiles[1]!, config);
    const removed = await invoke('remove', 'daemon', '--yes');
    expect(removed.stdout + removed.stderr).toContain('runtimes retained');
    expect(inspectHostRemoval(f.home).state).toBe('removed');
    expect(existsSync(f.file)).toBe(false);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(true);
    expect(existsSync(f.release)).toBe(true);
    expect(statSync(profiles[0]!).ino).toBe(firstInode);
    for (const path of profiles)
      expect(readPrivateJson(path)).toEqual({ ...config, enabled: false });
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
    for (const path of profiles)
      expect(readPrivateJson(path)).toEqual({ ...config, enabled: false });
    await invoke('install', 'daemon');
    expect(readFileSync(join(f.home, 'starts'), 'utf8')).toBe('start\n');
  } finally {
    await pendingInstall?.catch(() => {});
    await close?.();
    registry.dispose();
    f.close();
  }
});
