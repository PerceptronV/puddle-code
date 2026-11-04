import { connect } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HostUpdateCommand, type HostUpdateOperation } from '@puddle/shared';
import { digest, ipcPath } from '@puddle/shared/node';
import { HostConnection } from '../../../src/lib/auth/connection-authority.js';
import { upgradeRuntime } from '../../../src/lib/installation/host/runtime.js';
import type { Transport } from '../../../src/lib/transport/transport.js';
import type { UpdateInspection } from '../../../../daemon/src/updates/preflight/inspection.js';
import { HostUpdateCoordinator } from '../../../../daemon/src/updates/coordinator.js';
import { startHostControl } from '../../../../daemon/src/security/control.js';
import { LeaseRegistry } from '../../../../daemon/src/security/leases.js';
import { candidateFixture } from '../../../../daemon/test/updates/preflight/helpers.js';
import { parseArgs } from '../../../src/cli/args.js';
import { runInstall, runUpgrade } from '../../../src/cli/manage.js';
import { runUpdates } from '../../../src/cli/management/updates.js';

const mock = vi.hoisted(() => ({
  stage: vi.fn(),
  transport: vi.fn(),
  latest: vi.fn(async () => '0.4.0'),
  daemon: vi.fn(),
}));
vi.mock('../../../src/lib/installation/host/staging.js', () => ({
  stageHostComponent: mock.stage,
}));
vi.mock('../../../src/lib/transport/open.js', () => ({ openHostTransport: mock.transport }));
vi.mock('../../../src/lib/installation/releases.js', () => ({ latestReleaseVersion: mock.latest }));
vi.mock('../../../src/lib/installation/upgrade.js', () => ({ upgradeDaemon: mock.daemon }));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function fixture(kind: 'local' | 'ssh' = 'local', minor = PROTOCOL_VERSION.minor) {
  const f = candidateFixture('runtime');
  f.store.stopBeforeDispatch(f.operation, 'cancelled', 'fixture preparation');
  vi.stubEnv('PUDDLE_HOME', f.home);
  const inspection: UpdateInspection = {
    fingerprint: digest('exact fixture inspection'),
    blockers: [],
    compatibility: { blockers: [], candidates: [], owners: [], inventory: null },
    capacity: { blockers: [], volumes: [] },
    impact: {
      fingerprint: digest('no interruption'),
      requiresInterruption: false,
      affected: { terminals: [], notebooks: [], compilation: [], programmes: [] },
    },
    supervision: { worker: { kind: 'systemd', domain: null }, daemon: null, blockers: [] },
  };
  const inspect = vi.fn(async () => inspection);
  let recover = false;
  const dispatch = vi.fn(async (operation: HostUpdateOperation) => {
    // Deterministic activation outcome, not a native supervisor/installer test.
    const accepted = f.store.dispatch(operation);
    const worker = f.store.claimExecution(accepted, accepted.dispatch_id!, accepted.preflight!);
    try {
      if (recover) worker.failed('Fixture activation requires inspection');
      else {
        worker.verifying();
        worker.complete(digest('fixture verified selection'));
      }
    } finally {
      worker.release();
    }
  });
  const coordinator = new HostUpdateCoordinator({
    home: f.home,
    operations: f.store,
    inspection: { inspect },
    installedRuntime: () => f.capabilities.runtime,
    dispatch,
  });
  const registry = new LeaseRegistry();
  cleanup.push(() => registry.dispose());
  cleanup.push(() => coordinator.close());
  const commands: HostUpdateCommand[] = [];
  cleanup.push(
    await startHostControl(
      f.home,
      registry,
      () => ({
        port: 7434,
        version: { version: '0.4.0', protocol: { ...PROTOCOL_VERSION, minor } },
      }),
      (command, authorised) => {
        commands.push(command);
        return coordinator.execute(command, authorised);
      },
    ),
  );
  let installed: string | null = '0.3.14';
  const transport: Transport = {
    kind,
    label: 'fixture-host',
    async exec(command) {
      return command.includes('/VERSION')
        ? { code: installed ? 0 : 3, stdout: installed ?? '', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
    async openChannel() {
      return connect(ipcPath(f.home, 'host'));
    },
    async readFile() {
      return null;
    },
    async copyTo() {
      throw new Error('Stage delivery is replaced by the verified fixture');
    },
    dispose: vi.fn(),
  };
  mock.transport.mockResolvedValue(transport);
  mock.stage.mockReset().mockResolvedValue(f.stage);
  mock.daemon.mockReset().mockResolvedValue({ from: '0.3.14', to: '0.4.0', liveSessions: 0 });
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    ...f,
    transport,
    logger,
    commands,
    dispatch,
    inspect,
    inspection,
    setInstalled(value: string | null) {
      installed = value;
    },
    requireRecovery() {
      recover = true;
    },
  };
}

it.each(['local', 'ssh'] as const)(
  'upgrades the runtime through %s private control without installing a daemon',
  async (kind) => {
    const f = await fixture(kind);
    const command = parseArgs([
      'upgrade',
      'runtime@0.4.0',
      'user@host',
      '--tarball',
      '/verified.tar.gz',
    ]);
    if (command.cmd !== 'upgrade') throw new Error('wrong command');
    expect(await runUpgrade(command, f.logger)).toBe(0);
    expect(mock.stage).toHaveBeenCalledExactlyOnceWith(
      f.transport,
      'runtime',
      expect.objectContaining({
        version: '0.4.0',
        tarball: '/verified.tar.gz',
      }),
    );
    expect(f.commands.map((command) => command.action)).toEqual([
      'begin',
      'stage',
      'inspect',
      'apply',
    ]);
    expect(f.store.read()?.phase).toBe('complete');
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(mock.daemon).not.toHaveBeenCalled();
    expect(f.transport.dispose).toHaveBeenCalledOnce();
  },
);

it('keeps an existing runtime default on install and retains the transport until a missing default is installed', async () => {
  const f = await fixture();
  expect(await runInstall({ cmd: 'install', what: 'runtime' }, f.logger)).toBe(0);
  expect(mock.stage).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
  f.setInstalled(null);
  vi.mocked(f.transport.dispose).mockClear();
  mock.stage.mockImplementationOnce(async () => {
    expect(f.transport.dispose).not.toHaveBeenCalled();
    return f.stage;
  });
  expect(await runInstall({ cmd: 'install', what: 'runtime' }, f.logger)).toBe(0);
  expect(mock.latest).toHaveBeenCalledOnce();
  expect(f.store.read()?.phase).toBe('complete');
  expect(f.transport.dispose).toHaveBeenCalledOnce();
});

it('observes completion after a lost apply response and replacement lease without repeating dispatch', async () => {
  const f = await fixture();
  const original = HostConnection.prototype.hostUpdate;
  vi.spyOn(HostConnection.prototype, 'hostUpdate').mockImplementation(async function (
    this: HostConnection,
    command,
  ) {
    const result = await original.call(this, command);
    if (command.action === 'apply') {
      this.setTransportAvailable(false);
      throw new Error('apply response lost');
    }
    return result;
  });
  const result = await upgradeRuntime(f.transport, { version: '0.4.0' });
  expect(result.operation.phase).toBe('complete');
  expect(f.commands.filter((command) => command.action === 'apply')).toHaveLength(1);
  expect(f.commands.some((command) => command.action === 'status')).toBe(true);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('does not approve after the participating connection changes during inspection', async () => {
  const f = await fixture();
  const original = HostConnection.prototype.hostUpdate;
  vi.spyOn(HostConnection.prototype, 'hostUpdate').mockImplementation(async function (
    this: HostConnection,
    command,
  ) {
    const result = await original.call(this, command);
    if (command.action === 'inspect') this.setTransportAvailable(false);
    return result;
  });
  await expect(upgradeRuntime(f.transport, { version: '0.4.0' })).rejects.toThrow(
    'connection changed',
  );
  expect(f.store.read()?.phase).toBe('preflight');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('coalesces two callers while one stages and lets the other observe the same completed operation', async () => {
  const f = await fixture();
  let release!: () => void;
  mock.stage.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.stage;
  });
  const first = upgradeRuntime(f.transport, { version: '0.4.0' });
  await expect.poll(() => mock.stage.mock.calls.length).toBe(1);
  const second = upgradeRuntime(f.transport, { version: '0.4.0' });
  await expect
    .poll(() => f.commands.filter((command) => command.action === 'begin').length)
    .toBe(2);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.operation.id).toBe(b.operation.id);
  expect(b.operation.phase).toBe('complete');
  expect(mock.stage).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('reports recoverable worker failure and refuses cancellation after dispatch', async () => {
  const f = await fixture();
  f.requireRecovery();
  await expect(upgradeRuntime(f.transport, { version: '0.4.0' })).rejects.toThrow(
    'requires inspection',
  );
  const operation = f.store.read()!;
  expect(operation.phase).toBe('recovery_required');
  await runUpdates({ cmd: 'updates', operation: operation.id, cancel: false }, f.logger);
  expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining('recovery_required'));
  await expect(
    runUpdates({ cmd: 'updates', operation: operation.id, cancel: true }, f.logger),
  ).rejects.toThrow('not cancelled');
  expect(f.store.read()).toEqual(operation);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('lets the user cancel an exact preparation and leaves another id untouched', async () => {
  const f = await fixture();
  const operation = f.store.downloading(f.store.begin(f.operation.targets).operation);
  await expect(
    runUpdates({ cmd: 'updates', operation: f.operation.id, cancel: true }, f.logger),
  ).rejects.toThrow('not cancelled');
  expect(f.store.read()).toEqual(operation);
  expect(
    await runUpdates({ cmd: 'updates', operation: operation.id, cancel: true }, f.logger),
  ).toBe(0);
  expect(f.store.read()?.phase).toBe('cancelled');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('rejects older hosts before staging and never falls back to immediate installation', async () => {
  const f = await fixture('local', 6);
  await expect(upgradeRuntime(f.transport, { version: '0.4.0' })).rejects.toThrow('unavailable');
  expect(mock.stage).not.toHaveBeenCalled();
  expect(mock.daemon).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
});

it('requires a new user action when inspection changes before apply', async () => {
  const f = await fixture();
  f.inspect.mockImplementationOnce(async () => f.inspection);
  f.inspect.mockImplementationOnce(async () => ({
    ...f.inspection,
    fingerprint: digest('changed evidence'),
  }));
  await expect(upgradeRuntime(f.transport, { version: '0.4.0' })).rejects.toThrow('conflict');
  expect(f.commands.filter((command) => command.action === 'apply')).toHaveLength(1);
  expect(f.store.read()?.phase).toBe('preflight');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('includes an installed runtime in bare host upgrades, resolving the host release once', async () => {
  const f = await fixture('ssh');
  mock.stage.mockImplementationOnce(async () => {
    expect(mock.daemon).toHaveBeenCalledOnce();
    expect(f.transport.dispose).not.toHaveBeenCalled();
    return f.stage;
  });
  expect(await runUpgrade({ cmd: 'upgrade', host: 'user@host' }, f.logger)).toBe(0);
  expect(mock.latest).toHaveBeenCalledOnce();
  expect(mock.daemon).toHaveBeenCalledWith(
    f.transport,
    expect.objectContaining({ version: '0.4.0' }),
  );
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.store.read()?.phase).toBe('complete');
  expect(f.transport.dispose).toHaveBeenCalledOnce();
});

it('refuses ambiguous local archives before changing either host component', async () => {
  const f = await fixture('ssh');
  await expect(
    runUpgrade({ cmd: 'upgrade', what: 'runtime', tarball: 'archive.tar.gz' }, f.logger),
  ).rejects.toThrow('explicit @version');
  await expect(
    runUpgrade({ cmd: 'upgrade', host: 'user@host', tarball: 'archive.tar.gz' }, f.logger),
  ).rejects.toThrow('explicit @version');
  expect(mock.daemon).not.toHaveBeenCalled();
  expect(mock.stage).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
});
