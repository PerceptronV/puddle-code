import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  hostUpdateRecoveryJobSchema,
} from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { hostUpdateActionsSchema } from '@puddle/shared';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeReconciler } from '../../../src/runtime/controller/reconcile.js';
import { RuntimeClient, RuntimeConnectionLost } from '../../../src/runtime/transport/client.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import {
  HostUpdateCheckpointWriter,
  readHostUpdateCheckpoint,
  runtimeCheckpointOwner,
} from '../../../src/updates/checkpoints/store.js';
import {
  HostUpdateAdoptionWriter,
  readHostUpdateAdoption,
} from '../../../src/updates/checkpoints/adoption.js';
import { verifyHostUpdateAdoption } from '../../../src/updates/verification/adoption.js';
import { claimUpdateContinuation } from '../../../src/updates/recovery/continuation.js';
import { updateWorkerDirectory } from '../../../src/updates/worker/supervisor.js';
import { prepareServiceReplacement } from '../../../src/host/supervision/replacement.js';
import { inspectRunningService } from '../../../src/host/supervision/inspection.js';
import {
  acquireRuntimeControllerWhenAvailable,
  readRuntimeController,
} from '../../../src/runtime/ownership/storage.js';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { HostUpdateCoordinator } from '../../../src/updates/coordinator.js';
import { LeaseRegistry } from '../../../src/security/leases.js';
import { startHostControl } from '../../../src/security/control.js';
import { writeRuntime } from '../../../src/runtime-file.js';
import { openDatabase } from '../../../src/db/db.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { clients, launchOwner, terminal, waitForOwner } from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';
import { checkpointWorker } from '../../helpers/update-checkpoint.js';
import { systemdObservation } from '../../helpers/host-supervision.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { HostUpdateRecoveryAttempts } from '../../../src/updates/recovery/worker/records.js';

async function fixture() {
  const f = runtimeDatabase();
  const child = launchOwner(f.home, f.binding.runtime_id);
  await waitForOwner(child, f.directory);
  const first = await RuntimeClient.open(f.home, f.launch, f.controller.record);
  clients.push(first);
  await f.reconciler.attach(f.binding.runtime_id, first);
  const store = new HostUpdateOperations(f.home);
  let operation = store.begin([{ component: 'daemon', version: '0.4.0' }]).operation;
  // Metadata fixture: these executable paths are injected into the observer, never run.
  const release = runtimeRelease(f.home, '0.4.0');
  const entryPath = join(release.release, 'daemon', 'puddled.mjs');
  writeFileSync(entryPath, '// fixture\n');
  const record = {
    format: 1 as const,
    component: 'daemon' as const,
    generation: basename(release.release),
    version: '0.4.0',
    protocol: PROTOCOL_VERSION,
    archive_sha256: digest('archive'),
    tree_sha256: digest('tree'),
    checksum_verified: true,
  };
  const stage = { record, digest: digest(`${JSON.stringify(record)}\n`) };
  writeFileSync(join(release.release, '.puddle-stage.json'), JSON.stringify(record), {
    mode: 0o600,
  });
  operation = store.staged(operation, stage);
  operation = store.preflight(operation, digest('preflight'));
  operation = store.approve(operation, operation.preflight!);
  operation = store.dispatch(operation);
  const checkpoint = new HostUpdateCheckpointWriter(
    { ...f, version: '0.3.14' },
    {
      operation_id: operation.id,
      dispatch_id: operation.dispatch_id!,
      preflight: operation.preflight!,
    },
  );
  await f.reconciler.close();
  first.close();
  checkpoint.commit(f.controller.record);
  f.controller.release();
  const reconciler = new RuntimeReconciler(f);
  const connections = new RuntimeConnections(
    f.home,
    f.runtimes,
    {
      connected: (id, client) => reconciler.attach(id, client),
      missing: (id) => reconciler.retire(id),
    },
    await acquireRuntimeControllerWhenAvailable(f.home),
  );
  await connections.connect();
  const dispatched = operation;
  const worker = store.claimExecution(operation, operation.dispatch_id!, operation.preflight!);
  operation = worker.verifying();
  const deps = {
    home: f.home,
    db: f.db,
    runtimes: f.runtimes,
    connections,
    reconciler,
    version: '0.4.0',
    nodePath: join(release.release, 'bin', 'node'),
    entryPath,
    port: () => 12345,
  };
  const writer = new HostUpdateAdoptionWriter(deps);
  await vi.waitFor(() => expect(writer.observe(operation, randomUUID())).toBe(true));
  return {
    ...f,
    owner: child,
    deps,
    writer,
    worker,
    operation,
    dispatched,
    connections,
    reconciler,
    async close() {
      worker.release();
      await reconciler.close();
      await connections.close();
      f.db.close();
    },
  };
}

it('requires exact generation, increasing controller identity and settled authenticated owners', async () => {
  const f = await fixture();
  try {
    const nonce = randomUUID();
    expect(f.writer.observe(f.operation, nonce)).toBe(true);
    const proof = readHostUpdateAdoption(f.home, f.operation.id);
    writeFileSync(
      join(f.home, 'updates', 'adoptions', `${f.operation.id}.json`),
      JSON.stringify({
        ...proof,
        future_capability: true,
        daemon: { ...proof.daemon, future_capability: true },
      }),
    );
    expect(readHostUpdateAdoption(f.home, f.operation.id)).toEqual(proof);
    expect(proof.nonce).toBe(nonce);
    expect(proof.daemon.controller.epoch).toBeGreaterThan(f.controller.record.epoch);
    expect(proof.owners).toEqual([
      {
        runtime_id: f.binding.runtime_id,
        event_cursor: f.runtimes.get(f.binding.runtime_id)!.event_cursor,
        state: 'running',
      },
    ]);
    expect(
      new HostUpdateAdoptionWriter({ ...f.deps, nodePath: process.execPath }).observe(
        f.operation,
        randomUUID(),
      ),
    ).toBe(false);
    const control = vi
      .spyOn(f.connections, 'controllerIdentity')
      .mockReturnValue(f.controller.record);
    expect(f.writer.observe(f.operation, randomUUID())).toBe(false);
    control.mockRestore();
    const settled = vi.spyOn(f.reconciler, 'settled').mockReturnValue(false);
    expect(f.writer.observe(f.operation, randomUUID())).toBe(false);
    settled.mockRestore();
    const row = f.runtimes.get(f.binding.runtime_id)!;
    const get = vi.spyOn(f.runtimes, 'get');
    for (const change of [
      { incarnation: randomUUID() },
      { build: 'wrong' },
      { event_cursor: -1 },
      { state: 'interrupted' as const },
    ]) {
      get.mockReturnValue({ ...row, ...change });
      expect(f.writer.observe(f.operation, randomUUID())).toBe(false);
    }
    get.mockRestore();
    const client = f.connections.get(f.binding.runtime_id)!;
    const state = client.state!;
    client.state = { ...state, binding: null };
    expect(f.writer.observe(f.operation, randomUUID())).toBe(false);
    client.state = { ...state, persistence_pending: true };
    expect(f.writer.observe(f.operation, randomUUID())).toBe(false);
    client.state = state;
    const reader = openDatabase(f.paths.dbFile);
    try {
      f.db.pragma('busy_timeout = 1');
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM runtime_bindings').all();
      f.sessions.setStatus(f.session.id, 'waiting_input');
      expect(() => f.writer.observe(f.operation, randomUUID())).toThrow(
        /did not checkpoint completely/,
      );
    } finally {
      reader.close();
    }
    // Failed observations do not silently refresh earlier evidence.
    expect(readHostUpdateAdoption(f.home, f.operation.id).nonce).toBe(nonce);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('accepts a confirmed final exit without pretending that it is a running owner', async () => {
  const f = await fixture();
  try {
    const client = f.connections.get(f.binding.runtime_id)!;
    const ended = once(f.owner.child, 'exit');
    await client.request({ t: 'stop', placement: placement(client) }).catch((error: unknown) => {
      if (!(error instanceof RuntimeConnectionLost)) throw error;
    });
    await ended;
    await f.connections.connect();
    await vi.waitFor(() => expect(f.writer.observe(f.operation, randomUUID())).toBe(true));
    expect(readHostUpdateAdoption(f.home, f.operation.id).owners).toMatchObject([
      { runtime_id: f.binding.runtime_id, state: 'exited' },
    ]);
  } finally {
    await f.close();
  }
});

it.each(['verifying', 'recovery_required', 'continuation', 'restart-owners'] as const)(
  'verifies fresh adoption in %s and refuses stale receipts after a failed observation',
  async (phase) => {
    const f = await fixture();
    if (phase !== 'verifying') {
      f.operation = f.worker.failed('Success acknowledgement was lost');
      f.worker.release();
    }
    let additionalOwner: string | undefined;
    if (phase === 'restart-owners') {
      const session = f.sessions.create({ ...f.session, id: randomUUID() });
      const launch = {
        ...f.launch,
        identity: {
          ...f.launch.identity,
          runtime_id: randomUUID(),
          incarnation: randomUUID(),
          launch_id: randomUUID(),
          session_id: session.id,
        },
      };
      additionalOwner = launch.identity.runtime_id;
      const directory = runtimeDirectory(f.home, additionalOwner);
      atomicPrivateJson(join(directory, 'launch.json'), launch);
      const binding = f.runtimes.prepare({
        identity: launch.identity,
        build: 'runtime-test',
        protocol: RUNTIME_PROTOCOL_VERSION,
        releasePath: directory,
      });
      const reference = f.operation;
      const recovery = new HostUpdateOperations(f.home).claimRecovery(reference);
      f.operation = recovery.operation;
      recovery.release();
      new HostUpdateRecoveryAttempts(f.home, f.operation.id).append(
        hostUpdateRecoveryJobSchema.parse({
          format: 1,
          id: randomUUID(),
          operation_id: f.operation.id,
          requested_revision: reference.revision,
          revision: f.operation.revision,
          original_dispatch_id: f.operation.dispatch_id,
          original_worker_id: f.operation.worker_id,
          preflight: f.operation.approved,
          original_worker_digest: digest('metadata fixture'),
          actions_digest: digest('step fixture'),
          daemon_restart: {
            fingerprint: digest('current recovery inspection'),
            database_schema_version: f.db.pragma('user_version', { simple: true }),
            owners: [runtimeCheckpointOwner(binding)],
          },
          service: {
            kind: 'systemd',
            name: 'puddle-recovery-fixture.service',
            domain: null,
            release_path: '/fixture',
            node_path: '/fixture/bin/node',
            entry_path: '/fixture/worker.mjs',
            installer_path: '/fixture/install.sh',
          },
        }),
        () => {},
      );
      // A newly recorded launch cannot be silently omitted from recovery adoption.
      expect(f.writer.observe(f.operation, randomUUID())).toBe(false);
      const owner = launchOwner(f.home, additionalOwner);
      await waitForOwner(owner, directory);
      await f.connections.connect();
      await vi.waitFor(() => expect(f.writer.observe(f.operation, randomUUID())).toBe(true));
    }
    const authority = new LeaseRegistry();
    let healthy = true;
    const server = createServer((request, response) => {
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!healthy || request.url !== '/api/version' || !authority.valid(token)) {
        response.writeHead(503).end();
        return;
      }
      response.end(JSON.stringify({ version: '0.4.0', protocol: PROTOCOL_VERSION }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    const port = address.port;
    f.deps.port = () => port;
    const observe = vi.fn((operation, nonce) => {
      f.writer.observe(operation, nonce);
    });
    const coordinator = new HostUpdateCoordinator({
      home: f.home,
      operations: new HostUpdateOperations(f.home),
      inspection: {
        inspect: async () => {
          throw new Error('No inspection in this fixture');
        },
      },
      installedRuntime: () => null,
      dispatch: async () => {
        throw new Error('No dispatch in this fixture');
      },
      observeAdoption: observe,
    });
    writeRuntime(f.paths, { pid: process.pid, port });
    const closeControl = await startHostControl(
      f.home,
      authority,
      () => ({ port, version: { version: '0.4.0', protocol: PROTOCOL_VERSION } }),
      (command, authorised) => coordinator.execute(command, authorised),
    );
    try {
      // Simulate additive metadata from a compatible newer outgoing daemon.
      const stored = {
        ...readHostUpdateCheckpoint(f.home, f.operation.id),
        future_capability: true,
      };
      writeFileSync(
        join(f.home, 'updates', 'checkpoints', `${f.operation.id}.json`),
        JSON.stringify(stored),
      );
      if (phase === 'continuation') {
        const store = new HostUpdateOperations(f.home);
        const job = checkpointWorker(
          f.home,
          {
            store,
            operation: f.dispatched,
            reference: {
              operation_id: f.operation.id,
              dispatch_id: f.operation.dispatch_id!,
              preflight: f.operation.approved!,
            },
          },
          { pid: stored.daemon.pid, controller: stored.daemon.controller },
        );
        const run: CompilationCommandRunner = async (command) => {
          if (!['cat', 'show'].includes(command.args[1]!))
            throw new Error('Recovery must not mutate a service');
          return {
            exitCode: 0,
            stderr: '',
            stdout:
              command.args[1] === 'cat'
                ? '[Service]\nRestart=always\n'
                : systemdObservation(process.pid),
          };
        };
        job.daemon_service = await prepareServiceReplacement(
          f.home,
          await inspectRunningService(
            f.home,
            { kind: 'systemd', name: 'puddled.service', domain: null },
            process.pid,
            run,
          ),
          { run },
        );
        job.connector = { state: 'absent' };
        const directory = updateWorkerDirectory(f.home, f.operation.id);
        atomicPrivateJson(join(directory, 'worker.json'), job);
        atomicPrivateJson(
          join(directory, 'actions.json'),
          hostUpdateActionsSchema.parse({
            format: 1,
            operation_id: f.operation.id,
            dispatch_id: f.operation.dispatch_id,
            worker_id: f.operation.worker_id,
            preflight: f.operation.approved,
            actions: [
              { action: 'stop-connector', state: 'finished' },
              { action: 'stop-daemon', state: 'finished' },
              { action: 'select-daemon', state: 'finished' },
              { action: 'start-daemon', state: 'started' },
              { action: 'start-connector', state: 'planned' },
            ],
          }),
        );
        const group = 2147483647;
        expect(() => process.kill(-group, 0)).toThrowError(
          expect.objectContaining({ code: 'ESRCH' }),
        );
        atomicPrivateJson(join(directory, 'lifetime.json'), {
          format: 1,
          operation_id: f.operation.id,
          dispatch_id: f.operation.dispatch_id,
          worker_id: f.operation.worker_id,
          preflight: f.operation.approved,
          process_group: group,
        });
        symlinkSync(
          join(f.home, 'bin/versions', f.operation.stages[0]!.record.generation),
          join(f.home, 'bin/current'),
        );
        const controller = readRuntimeController(f.home);
        const shell = terminal(f.connections.get(f.binding.runtime_id)!.state!).pid!;
        const recovery = await claimUpdateContinuation(f.home, f.operation, () => true, run);
        try {
          expect(recovery.mode).toBe('running');
          recovery.check();
          f.operation = recovery.operation;
          expect(readRuntimeController(f.home)).toEqual(controller);
          process.kill(shell, 0);
          expect(terminal(f.connections.get(f.binding.runtime_id)!.state!).pid).toBe(shell);
        } finally {
          recovery.release();
        }
        observe.mockClear();
      }
      const proof = await verifyHostUpdateAdoption(f.home, f.operation);
      if (additionalOwner) {
        expect(proof.checkpoint).not.toBe(digest(`${JSON.stringify(stored)}\n`));
        expect(proof.owners.map(({ runtime_id }) => runtime_id)).toEqual([
          f.binding.runtime_id,
          additionalOwner,
        ]);
      } else expect(proof.checkpoint).toBe(digest(`${JSON.stringify(stored)}\n`));
      expect(proof.owners[0]?.runtime_id).toBe(f.binding.runtime_id);
      expect(new HostUpdateOperations(f.home).read()?.phase).toBe(f.operation.phase);
      expect(observe).toHaveBeenCalledOnce();
      observe.mockImplementation(() => {});
      await expect(verifyHostUpdateAdoption(f.home, f.operation)).rejects.toThrow(/not proved/);
      observe.mockImplementation((operation, nonce) => {
        f.writer.observe(operation, nonce);
        writeRuntime(f.paths, { pid: process.pid + 1, port });
      });
      await expect(verifyHostUpdateAdoption(f.home, f.operation)).rejects.toThrow(/not proved/);
      healthy = false;
      await expect(verifyHostUpdateAdoption(f.home, f.operation)).rejects.toThrow(/HTTP authority/);
    } finally {
      coordinator.close();
      authority.dispose();
      await closeControl();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await f.close();
    }
  },
);
