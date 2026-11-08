import { connect } from 'node:net';
import { createServer } from 'node:http';
import { reviewedHostUpdate } from '../../../shared/test/helpers/host-update.js';
import { inspectHostLocally } from '../../src/lib/auth/host-inspection.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { startHostControl } from '../../../daemon/src/security/control.js';
import { LeaseRegistry } from '../../../daemon/src/security/leases.js';
import { ensureDaemon } from '../../src/lib/connection/frontend.js';
import type { Transport } from '../../src/lib/transport/transport.js';

const hostUpgrade = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/installation/host/upgrade.js', () => ({
  upgradeHostComponent: hostUpgrade,
}));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  hostUpgrade.mockReset();
});

async function fixture(
  kind: 'local' | 'ssh',
  outcome: 'ready' | 'lost-reply' | 'refused' = 'ready',
  older = false,
) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-start-selected-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubEnv('PUDDLE_HOME', home);
  const registry = new LeaseRegistry();
  cleanups.push(() => registry.dispose());
  let version = {
    version: '0.4.37',
    protocol: older ? { major: 25, minor: 20 } : PROTOCOL_VERSION,
  };
  const server = createServer((req, res) => {
    const token = req.headers.authorization?.slice('Bearer '.length) ?? '';
    if (!registry.valid(token)) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ status: 'running' }]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const commands: string[] = [];
  let starts = 0;
  const transport: Transport = {
    kind,
    label: 'fixture-host',
    async exec(command) {
      commands.push(command);
      if (command.endsWith('--inspect'))
        return { code: 0, stdout: JSON.stringify(await inspectHostLocally(home)), stderr: '' };
      if (command.includes('--start-daemon')) {
        starts++;
        if (outcome === 'refused') return { code: 1, stdout: '', stderr: 'private diagnostic' };
        cleanups.push(
          await startHostControl(home, registry, () => ({
            port,
            version,
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
  return {
    transport,
    commands,
    starts: () => starts,
    version: () => version,
    upgrade: () => {
      version = { version: '0.4.0', protocol: PROTOCOL_VERSION };
    },
  };
}

it.each(['local', 'ssh'] as const)(
  'starts the selected %s release without reinstalling or requiring release equality',
  async (kind) => {
    const f = await fixture(kind);
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
  const f = await fixture('ssh', 'lost-reply');
  const endpoint = await ensureDaemon(f.transport, {});
  cleanups.push(() => endpoint.authority.close());
  expect(endpoint.authority.version?.version).toBe('0.4.37');
  expect(f.starts()).toBe(1);
});

it('does not reinstall or use the attached fallback when selected startup is refused', async () => {
  const f = await fixture('ssh', 'refused');
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

// This exercises selected-service dispatch, real local private control/inspection and
// the shared launcher handshake. Activation is injected; packaged worker continuity
// is covered separately and this fixture never starts a production service.
it.each(['local', 'ssh'] as const)(
  'inspects a stopped older %s host before both approvals',
  async (kind) => {
    const f = await fixture(kind, 'ready', true);
    const review = reviewedHostUpdate();
    const confirmDaemonUpgrade = vi.fn(async () => true);
    const confirmInterruption = vi.fn(async () => true);
    hostUpgrade.mockImplementationOnce(async (_transport, _component, options) => {
      expect(confirmDaemonUpgrade).toHaveBeenCalledOnce();
      expect(options.outgoing).toEqual(f.version());
      if (!(await options.confirmInterruption(review)))
        throw new Error('Interruption not approved');
      f.upgrade();
      return { from: '0.4.37', to: '0.4.0' };
    });
    const endpoint = await ensureDaemon(f.transport, {
      version: '0.4.0',
      confirmDaemonUpgrade,
      confirmInterruption,
    });
    cleanups.push(() => endpoint.authority.close());
    expect(endpoint.authority.version?.protocol).toEqual(PROTOCOL_VERSION);
    expect(endpoint.authority.credential()).toMatch(/^cn_/);
    expect(confirmDaemonUpgrade).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        daemon: { version: '0.4.37', protocol: { major: 25, minor: 20 } },
        liveSessions: 1,
      }),
    );
    expect(confirmInterruption).toHaveBeenCalledExactlyOnceWith(review);
    expect(hostUpgrade).toHaveBeenCalledOnce();
    expect(f.starts()).toBe(1);
    expect(f.commands.some((command) => command.startsWith('sh -s'))).toBe(false);
  },
);
it.each(['declined', 'missing', 'no-upgrade'] as const)(
  'leaves the started older host untouched after %s approval',
  async (mode) => {
    const f = await fixture('local', 'ready', true);
    const confirmDaemonUpgrade = vi.fn(async () => false);
    const confirmInterruption = vi.fn(async () => true);
    await expect(
      ensureDaemon(f.transport, {
        noUpgrade: mode === 'no-upgrade',
        confirmDaemonUpgrade: mode === 'missing' ? undefined : confirmDaemonUpgrade,
        confirmInterruption,
      }),
    ).rejects.toMatchObject({ code: 'upgrade_failed' });
    expect(f.starts()).toBe(1);
    expect(await inspectHostLocally(process.env.PUDDLE_HOME!)).toMatchObject({
      version: f.version(),
      liveSessions: 1,
    });
    expect(hostUpgrade).not.toHaveBeenCalled();
    expect(confirmInterruption).not.toHaveBeenCalled();
    expect(f.commands.some((command) => command.startsWith('sh -s'))).toBe(false);
  },
);
