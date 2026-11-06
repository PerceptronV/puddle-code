import { connect } from 'node:net';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HostUpdateCommand, type HostUpdateOperation } from '@puddle/shared';
import { atomicPrivateJson, digest, ipcPath } from '@puddle/shared/node';
import { checkpointWorker } from '../../../../daemon/test/helpers/update-checkpoint.js';
import { updateWorkerDirectory } from '../../../../daemon/src/updates/worker/supervisor.js';
import { HostConnection } from '../../../src/lib/auth/connection-authority.js';
import { upgradeHostComponent } from '../../../src/lib/installation/host/upgrade.js';
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

async function fixture(
  kind: 'local' | 'ssh' = 'local',
  minor: number = PROTOCOL_VERSION.minor,
  component: 'runtime' | 'daemon' = 'runtime',
  major: number = PROTOCOL_VERSION.major,
) {
  let hostProtocol = { major, minor };
  const f = candidateFixture(component);
  f.store.stopBeforeDispatch(f.operation, 'cancelled', 'fixture preparation');
  vi.stubEnv('PUDDLE_HOME', f.home);
  const inspection: UpdateInspection = {
    fingerprint: digest('exact fixture inspection'),
    connector: { state: 'not-required', identity: null, blockers: [] },
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
  if (component === 'daemon') {
    inspection.connector = { state: 'absent', identity: null, blockers: [] };
    inspection.supervision.daemon = {
      kind: 'systemd',
      name: 'puddled.service',
      domain: null,
      pid: process.pid,
      invocation: 'a'.repeat(32),
      controlGroup: '/fixture/puddled.service',
      definition_path: null,
      definition_digest: digest('fixture service'),
    };
  }
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
    ...(component === 'daemon'
      ? {
          pauseDaemon: async () => ({
            release() {},
            outgoing: { pid: process.pid, controller: { id: randomUUID(), epoch: 1 } },
          }),
        }
      : {}),
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
        version: { version: '0.4.0', protocol: hostProtocol },
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
    openChannel() {
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
    setProtocol(protocol: { major: number; minor: number }) {
      hostProtocol = protocol;
    },
    requireRecovery() {
      recover = true;
    },
  };
}

it.each(['local', 'ssh'] as const)(
  'updates a daemon through %s private control using the existing staging and observation path',
  async (kind) => {
    const f = await fixture(kind, PROTOCOL_VERSION.minor, 'daemon');
    const confirmInterruption = vi.fn(async () => true);
    const result = await upgradeHostComponent(f.transport, 'daemon', {
      version: '0.4.0',
      confirmInterruption,
    });
    expect(result.operation.phase).toBe('complete');
    expect(f.commands.map(({ action }) => action)).toEqual(['begin', 'stage', 'inspect', 'apply']);
    expect(mock.stage).toHaveBeenCalledExactlyOnceWith(
      f.transport,
      'daemon',
      expect.objectContaining({ version: '0.4.0' }),
    );
    expect(confirmInterruption).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  },
);

it.each(['approve', 'decline', 'missing', 'changed-impact', 'changed-authority'] as const)(
  'binds daemon interruption approval to reviewed work and participating authority (%s)',
  async (answer) => {
    const f = await fixture('local', PROTOCOL_VERSION.minor, 'daemon');
    f.inspection.impact.requiresInterruption = true;
    f.inspection.impact.affected.notebooks = [
      {
        instance: randomUUID(),
        revision: 1,
        path: '/project/example.ipynb',
        kernel: 'python3',
        state: 'idle',
        busy: false,
        changing: false,
      },
    ];
    let loseAuthority: (() => void) | undefined;
    const original = HostConnection.prototype.hostUpdate;
    vi.spyOn(HostConnection.prototype, 'hostUpdate').mockImplementation(function (
      this: HostConnection,
      command,
    ) {
      loseAuthority = () => this.setTransportAvailable(false);
      return original.call(this, command);
    });
    const confirmInterruption = vi.fn(
      async ({ review }: { review: import('@puddle/shared').HostUpdateReview }) => {
        expect(f.dispatch).not.toHaveBeenCalled();
        expect(review.affected.notebooks).toBe(1);
        if (answer === 'changed-impact') f.inspection.fingerprint = digest('new kernel');
        if (answer === 'changed-authority') loseAuthority!();
        return answer !== 'decline';
      },
    );
    const pending = upgradeHostComponent(f.transport, 'daemon', {
      version: '0.4.0',
      confirmInterruption: answer === 'missing' ? undefined : confirmInterruption,
    });
    if (answer === 'approve') {
      expect((await pending).operation.phase).toBe('complete');
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.commands.at(-1)).toMatchObject({
        action: 'apply',
        fingerprint: f.inspection.fingerprint,
        interruption_approval: f.inspection.fingerprint,
      });
    } else {
      await expect(pending).rejects.toThrow();
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.store.read()?.phase).toBe('preflight');
      expect(f.commands.filter(({ action }) => action === 'apply')).toHaveLength(
        answer === 'changed-impact' ? 1 : 0,
      );
    }
  },
);

it('observes a daemon update after a lost activation reply without repeating approval', async () => {
  const f = await fixture('ssh', PROTOCOL_VERSION.minor, 'daemon');
  const original = HostConnection.prototype.hostUpdate;
  vi.spyOn(HostConnection.prototype, 'hostUpdate').mockImplementation(async function (
    this: HostConnection,
    command,
  ) {
    const result = await original.call(this, command);
    if (command.action === 'apply') {
      this.setTransportAvailable(false);
      throw new Error('Daemon activation reply lost');
    }
    return result;
  });
  expect(
    (await upgradeHostComponent(f.transport, 'daemon', { version: '0.4.0' })).operation.phase,
  ).toBe('complete');
  expect(f.commands.filter(({ action }) => action === 'apply')).toHaveLength(1);
  expect(f.commands.some(({ action }) => action === 'status')).toBe(true);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

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
  const result = await upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' });
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
  await expect(upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' })).rejects.toThrow(
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
  const first = upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' });
  await expect.poll(() => mock.stage.mock.calls.length).toBe(1);
  const second = upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' });
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
  await expect(upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' })).rejects.toThrow(
    'requires inspection',
  );
  const operation = f.store.read()!;
  expect(operation.phase).toBe('recovery_required');
  await runUpdates(
    { cmd: 'updates', recover: false, operation: operation.id, cancel: false },
    f.logger,
  );
  expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining('recovery_required'));
  await expect(
    runUpdates({ cmd: 'updates', recover: false, operation: operation.id, cancel: true }, f.logger),
  ).rejects.toThrow('not cancelled');
  expect(f.store.read()).toEqual(operation);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('lets the user cancel an exact preparation and leaves another id untouched', async () => {
  const f = await fixture();
  const operation = f.store.downloading(f.store.begin(f.operation.targets).operation);
  await expect(
    runUpdates(
      { cmd: 'updates', recover: false, operation: f.operation.id, cancel: true },
      f.logger,
    ),
  ).rejects.toThrow('not cancelled');
  expect(f.store.read()).toEqual(operation);
  expect(
    await runUpdates(
      { cmd: 'updates', recover: false, operation: operation.id, cancel: true },
      f.logger,
    ),
  ).toBe(0);
  expect(f.store.read()?.phase).toBe('cancelled');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['local', 'ssh'] as const)(
  'verifies recovery through %s private authority without another dispatch',
  async (kind) => {
    const f = await fixture(kind);
    f.requireRecovery();
    await expect(
      upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' }),
    ).rejects.toThrow('requires inspection');
    const operation = f.store.read()!;
    // Selected-release and ended-worker metadata only; this suite never starts a supervisor.
    mkdirSync(join(f.root, 'bin'));
    mkdirSync(join(f.root, 'daemon'));
    writeFileSync(join(f.root, 'VERSION'), '0.4.0\n');
    writeFileSync(
      join(f.root, 'RUNTIME_PROTOCOL'),
      `${f.capabilities.runtime.major}.${f.capabilities.runtime.minor}\n`,
    );
    writeFileSync(join(f.root, 'bin/node'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    writeFileSync(join(f.root, 'daemon/puddler.mjs'), '// fixture\n');
    symlinkSync(f.root, join(f.home, 'bin/runtime-current'));
    checkpointWorker(
      f.home,
      {
        store: f.store,
        operation: { ...operation, revision: operation.revision - 2 },
        reference: {
          operation_id: operation.id,
          dispatch_id: operation.dispatch_id!,
          preflight: operation.approved!,
        },
      },
      { pid: 123, controller: { id: randomUUID(), epoch: 1 } },
    );
    expect(() => process.kill(-2147483647, 0)).toThrowError(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    atomicPrivateJson(join(updateWorkerDirectory(f.home, operation.id), 'lifetime.json'), {
      format: 1,
      operation_id: operation.id,
      dispatch_id: operation.dispatch_id,
      worker_id: operation.worker_id,
      preflight: operation.approved,
      process_group: 2147483647,
    });
    const offset = f.commands.length;
    const command = {
      cmd: 'updates' as const,
      operation: operation.id,
      cancel: false,
      recover: true,
      ...(kind === 'ssh' ? { host: 'user@host' } : {}),
    };
    expect(await runUpdates(command, f.logger)).toBe(0);
    expect(f.store.read()?.phase).toBe('complete');
    expect(f.commands.slice(offset).map((item) => item.action)).toEqual(['status', 'recover']);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(await runUpdates(command, f.logger)).toBe(0);
    expect(f.dispatch).toHaveBeenCalledOnce();
  },
);

it('does not send recovery to an incompatible older host or repeat an incomplete installation', async () => {
  const f = await fixture('local');
  f.requireRecovery();
  await expect(upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' })).rejects.toThrow(
    'requires inspection',
  );
  const operation = f.store.read()!;
  f.setProtocol({ major: 25, minor: 10 });
  await expect(
    runUpdates({ cmd: 'updates', operation: operation.id, cancel: false, recover: true }, f.logger),
  ).rejects.toThrow('does not match');
  expect(f.commands.some((command) => command.action === 'recover')).toBe(false);
  expect(f.store.read()).toEqual(operation);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('rejects older hosts before staging and never falls back to immediate installation', async () => {
  const f = await fixture('local', 6, 'runtime', 25);
  await expect(upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' })).rejects.toThrow(
    'does not match',
  );
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
  await expect(upgradeHostComponent(f.transport, 'runtime', { version: '0.4.0' })).rejects.toThrow(
    'conflict',
  );
  expect(f.commands.filter((command) => command.action === 'apply')).toHaveLength(1);
  expect(f.store.read()?.phase).toBe('preflight');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('includes an installed runtime in bare host upgrades, resolving each component independently', async () => {
  const f = await fixture('ssh');
  mock.stage.mockImplementationOnce(async () => {
    expect(mock.daemon).toHaveBeenCalledOnce();
    expect(f.transport.dispose).not.toHaveBeenCalled();
    return f.stage;
  });
  expect(await runUpgrade({ cmd: 'upgrade', host: 'user@host' }, f.logger)).toBe(0);
  expect(mock.latest).toHaveBeenCalledWith({ component: 'daemon' });
  expect(mock.latest).toHaveBeenCalledWith({ component: 'runtime' });
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

it.each(['approve', 'decline', 'missing', 'changed-impact'] as const)(
  'updates an inspected older application major only after exact interruption consent (%s)',
  async (answer) => {
    const f = await fixture('ssh', 20, 'daemon', 25);
    f.inspection.impact.requiresInterruption = true;
    f.inspection.impact.affected.notebooks = [
      {
        instance: randomUUID(),
        revision: 1,
        path: '/fixture.ipynb',
        kernel: 'python3',
        state: 'idle',
        busy: false,
        changing: false,
      },
    ];
    const confirmInterruption = vi.fn(
      async ({ review }: { review: import('@puddle/shared').HostUpdateReview }) => {
        expect(review.affected.notebooks).toBe(1);
        expect(f.dispatch).not.toHaveBeenCalled();
        if (answer === 'changed-impact')
          f.inspection.fingerprint = digest('changed after old-major review');
        return answer === 'approve' || answer === 'changed-impact';
      },
    );
    const pending = upgradeHostComponent(f.transport, 'daemon', {
      version: '0.4.0',
      outgoing: { version: '0.4.0', protocol: { major: 25, minor: 20 } },
      confirmInterruption: answer === 'missing' ? undefined : confirmInterruption,
    });
    if (answer === 'approve') {
      expect((await pending).operation.phase).toBe('complete');
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.commands.at(-1)).toMatchObject({
        action: 'apply',
        interruption_approval: f.inspection.fingerprint,
      });
    } else {
      await expect(pending).rejects.toThrow();
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.store.read()?.phase).toBe('preflight');
    }
    expect(mock.stage).toHaveBeenCalledOnce();
    expect(f.commands.filter(({ action }) => action === 'apply')).toHaveLength(
      answer === 'approve' || answer === 'changed-impact' ? 1 : 0,
    );
  },
);
