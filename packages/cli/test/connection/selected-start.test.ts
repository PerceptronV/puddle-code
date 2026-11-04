import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { startHostControl } from '../../../daemon/src/security/control.js';
import { LeaseRegistry } from '../../../daemon/src/security/leases.js';
import { ensureDaemon } from '../../src/lib/connection/cockpit.js';
import type { Transport } from '../../src/lib/transport/transport.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

function fixture(kind: 'local' | 'ssh', outcome: 'ready' | 'lost-reply' | 'refused' = 'ready') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-start-selected-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubEnv('PUDDLE_HOME', home);
  const registry = new LeaseRegistry();
  cleanups.push(() => registry.dispose());
  const commands: string[] = [];
  let starts = 0;
  const transport: Transport = {
    kind,
    label: 'fixture-host',
    async exec(command) {
      commands.push(command);
      if (command.includes('--start-daemon')) {
        starts++;
        if (outcome === 'refused') return { code: 1, stdout: '', stderr: 'private diagnostic' };
        cleanups.push(
          await startHostControl(home, registry, () => ({
            port: 7434,
            version: { version: '0.4.37', protocol: PROTOCOL_VERSION },
          })),
        );
        if (outcome === 'lost-reply') throw new Error('Startup reply lost');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    openChannel() {
      return connect(ipcPath(home, 'host'));
    },
    async readFile() {
      return null;
    },
    async copyTo() {
      throw new Error('Startup must not deliver another release');
    },
    dispose() {},
  };
  return { transport, commands, starts: () => starts };
}

it.each(['local', 'ssh'] as const)(
  'starts the selected %s release without reinstalling or requiring release equality',
  async (kind) => {
    const f = fixture(kind);
    const confirmDaemonUpgrade = vi.fn();
    const endpoint = await ensureDaemon(f.transport, {
      version: '0.4.0',
      tarball: '/must-not-read.tar.gz',
      noUpgrade: true,
      confirmDaemonUpgrade,
    });
    cleanups.push(() => endpoint.authority.close());
    expect(endpoint.authority.version?.version).toBe('0.4.37');
    expect(endpoint.bootstrapped).toBe(true);
    expect(endpoint.daemonLifetime).toBe('persistent');
    expect(endpoint.authority.credential()).toMatch(/^cn_/);
    expect(f.starts()).toBe(1);
    expect(confirmDaemonUpgrade).not.toHaveBeenCalled();
    expect(f.commands.some((command) => command.startsWith('sh -s'))).toBe(false);
    const attached = await ensureDaemon(f.transport, {});
    cleanups.push(() => attached.authority.close());
    expect(attached.bootstrapped).toBe(false);
    expect(f.starts()).toBe(1);
  },
);

it('observes authenticated readiness after a lost startup reply without another dispatch', async () => {
  const f = fixture('ssh', 'lost-reply');
  const endpoint = await ensureDaemon(f.transport, {});
  cleanups.push(() => endpoint.authority.close());
  expect(endpoint.authority.version?.version).toBe('0.4.37');
  expect(f.starts()).toBe(1);
});

it('does not reinstall or use the attached fallback when selected startup is refused', async () => {
  const f = fixture('ssh', 'refused');
  const attachedFallback = vi.fn();
  await expect(
    ensureDaemon(f.transport, { startTimeoutMs: 0, attachedFallback }),
  ).rejects.toMatchObject({
    code: 'daemon_start_timeout',
    hint: expect.stringContaining('explicit recovery'),
  });
  expect(f.starts()).toBe(1);
  expect(f.commands.some((command) => command.startsWith('sh -s'))).toBe(false);
  expect(attachedFallback).not.toHaveBeenCalled();
});
