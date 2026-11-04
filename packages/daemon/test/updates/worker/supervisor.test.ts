import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostStageRecordSchema, type HostUpdateDaemonHandoff } from '@puddle/shared';
import { acquireRuntimeController } from '../../../src/runtime/ownership/storage.js';
import { digest } from '@puddle/shared/node';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { readUpdateWorker, startUpdateWorker } from '../../../src/updates/worker/supervisor.js';
import type {
  CompilationCommand,
  CompilationCommandRunner,
} from '../../../src/compilation/process.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(component: 'daemon' | 'runtime' = 'runtime') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-service-'));
  homes.push(home);
  const release = join(home, 'bin/versions/1.2.3~ABC123');
  mkdirSync(join(release, 'bin'), { recursive: true });
  mkdirSync(join(release, 'daemon'));
  writeFileSync(join(release, 'bin/node'), '', { mode: 0o755 });
  writeFileSync(join(release, 'daemon/host-update.mjs'), '');
  writeFileSync(join(release, 'daemon/install.sh'), '');
  const store = new HostUpdateOperations(home);
  const record = hostStageRecordSchema.parse({
    format: 1,
    component,
    generation: '1.2.3~ABC123',
    version: '1.2.3',
    protocol: { major: 1, minor: 0 },
    archive_sha256: digest('archive'),
    tree_sha256: digest('tree'),
    checksum_verified: true,
  });
  let operation = store.begin([{ component, version: '1.2.3' }]).operation;
  operation = store.staged(operation, { record, digest: digest(`${JSON.stringify(record)}\n`) });
  operation = store.preflight(operation, digest('approved host impact'));
  operation = store.approve(operation, operation.preflight!);
  const commands: CompilationCommand[] = [];
  const run: CompilationCommandRunner = async (command) => {
    commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { home, release, store, operation, commands, run };
}

it.each(['systemd', 'launchd'] as const)(
  'dispatches one independent bounded %s job, pinning exact executable paths',
  async (kind) => {
    const f = fixture();
    const job = await startUpdateWorker(f.home, f.operation, {
      kind,
      releasePath: f.release,
      uid: 501,
      run: f.run,
    });
    expect(job.state).toBe('dispatched');
    expect(job.node_path).toBe(realpathSync(join(f.release, 'bin/node')));
    expect(job.entry_path).toBe(realpathSync(join(f.release, 'daemon/host-update.mjs')));
    const definition = readFileSync(f.commands[0]!.args[2]!, 'utf8');
    expect(definition).not.toMatch(
      /puddled\.service|dev\.puddle\.puddled|PartOf=|BindsTo=|WantedBy=/,
    );
    if (kind === 'systemd') {
      expect(f.commands.map((command) => command.args[1])).toEqual([
        'link',
        'daemon-reload',
        'start',
      ]);
      expect(definition).toContain('Restart=no');
      expect(definition).toContain('RuntimeMaxSec=180');
    } else {
      expect(f.commands).toHaveLength(1);
      expect(definition).toContain('<key>KeepAlive</key><false/>');
      expect(definition).toContain('<key>AbandonProcessGroup</key><false/>');
    }
    expect(f.store.read()?.dispatch_id).toBe(job.dispatch_id);
    const count = f.commands.length;
    expect(
      await startUpdateWorker(f.home, f.operation, {
        kind,
        releasePath: '/missing/new/default',
        run: f.run,
      }),
    ).toEqual(job);
    expect(f.commands).toHaveLength(count);
  },
);

it('never repeats a dispatch after losing the supervisor reply, and fences its delayed worker during recovery', async () => {
  const f = fixture();
  let commands = 0;
  const run: CompilationCommandRunner = async () => {
    commands++;
    throw new Error('reply lost');
  };
  await expect(
    startUpdateWorker(f.home, f.operation, { kind: 'launchd', releasePath: f.release, run }),
  ).rejects.toThrow('reply lost');
  const job = readUpdateWorker(f.home, f.operation.id);
  expect(job.state).toBe('dispatching');
  const recovery = f.store.requireRecovery(f.store.read()!, 'supervisor outcome unknown');
  expect(
    await startUpdateWorker(f.home, f.operation, { kind: 'launchd', releasePath: f.release, run }),
  ).toEqual(job);
  expect(commands).toBe(1);
  expect(() =>
    f.store.claimExecution(
      { id: job.operation_id, revision: job.dispatch_revision },
      job.dispatch_id,
      job.preflight,
    ),
  ).toThrow();
  expect(f.store.read()).toEqual(recovery);
});

it('refuses unpinned executables and unsupported daemon replacement before consuming approval', async () => {
  const f = fixture();
  rmSync(join(f.release, 'bin/node'));
  symlinkSync(process.execPath, join(f.release, 'bin/node'));
  await expect(
    startUpdateWorker(f.home, f.operation, { kind: 'launchd', releasePath: f.release, run: f.run }),
  ).rejects.toThrow('pinned');
  expect(f.store.read()?.phase).toBe('approved');
  const daemon = fixture('daemon');
  await expect(
    startUpdateWorker(daemon.home, daemon.operation, {
      kind: 'systemd',
      releasePath: daemon.release,
      run: daemon.run,
    }),
  ).rejects.toThrow('adoption');
  expect(daemon.store.read()?.phase).toBe('approved');
  expect(daemon.commands).toHaveLength(0);
});

it('rechecks authority immediately before durable dispatch and leaves expired approval unconsumed', async () => {
  const f = fixture();
  let checks = 0;
  await expect(
    startUpdateWorker(f.home, f.operation, {
      kind: 'launchd',
      releasePath: f.release,
      run: f.run,
      authorised: () => ++checks === 1,
    }),
  ).rejects.toThrow('authority expired');
  expect(checks).toBe(2);
  expect(f.store.read()).toEqual(f.operation);
  expect(f.commands).toHaveLength(0);
  expect(() => readUpdateWorker(f.home, f.operation.id)).toThrow();
});

it('persists the exact outgoing controller and inspected daemon service before independent worker dispatch', async () => {
  const f = fixture('daemon');
  const controller = acquireRuntimeController(f.home);
  const { id, epoch } = controller.record;
  const daemon: HostUpdateDaemonHandoff = {
    interruption_approval: f.operation.preflight!,
    connector: { state: 'absent' },
    outgoing: { pid: process.pid, controller: { id, epoch } },
    daemon_service: {
      kind: 'systemd',
      name: 'puddled.service',
      domain: null,
      pid: process.pid,
      invocation: 'a'.repeat(32),
      controlGroup: '/user.slice/puddled.service',
      definition_path: null,
      definition_digest: digest('unchanged configuration'),
    },
  };
  let observed = false;
  try {
    await expect(
      startUpdateWorker(f.home, f.operation, {
        kind: 'systemd',
        releasePath: f.release,
        run: f.run,
        daemon: { ...daemon, interruption_approval: digest('stale interruption consent') },
      }),
    ).rejects.toThrow('Interruption approval changed');
    expect(f.store.read()?.dispatch_id).toBeNull();
    expect(f.commands).toHaveLength(0);
    const job = await startUpdateWorker(f.home, f.operation, {
      kind: 'systemd',
      releasePath: f.release,
      daemon,
      run: async (command) => {
        const recorded = readUpdateWorker(f.home, f.operation.id);
        expect(recorded).toMatchObject(daemon);
        expect(recorded.state).toBe('dispatching');
        expect(f.store.read()?.dispatch_id).toBe(recorded.dispatch_id);
        observed = true;
        return f.run(command);
      },
    });
    expect(observed).toBe(true);
    expect(job).toMatchObject({ ...daemon, state: 'dispatched' });
    expect(f.commands.map((command) => command.args[1])).toEqual([
      'link',
      'daemon-reload',
      'start',
    ]);
    expect(f.commands.at(-1)?.args.at(-1)).toBe(job.name);
    expect(job.name).not.toBe(daemon.daemon_service.name);
  } finally {
    controller.release();
  }
});

it('does not consume daemon approval when its outgoing controller is stale', async () => {
  const f = fixture('daemon');
  const controller = acquireRuntimeController(f.home);
  const { id, epoch } = controller.record;
  try {
    await expect(
      startUpdateWorker(f.home, f.operation, {
        kind: 'systemd',
        releasePath: f.release,
        run: f.run,
        daemon: {
          connector: { state: 'absent' },
          outgoing: { pid: process.pid, controller: { id, epoch: epoch + 1 } },
          daemon_service: {
            kind: 'systemd',
            name: 'puddled.service',
            domain: null,
            pid: process.pid,
            invocation: 'a'.repeat(32),
            controlGroup: '/user.slice/puddled.service',
            definition_path: null,
            definition_digest: digest('configuration'),
          },
        },
      }),
    ).rejects.toThrow('changed before update dispatch');
    expect(f.store.read()?.phase).toBe('approved');
    expect(f.commands).toHaveLength(0);
    expect(() => readUpdateWorker(f.home, f.operation.id)).toThrow('ENOENT');
  } finally {
    controller.release();
  }
});
