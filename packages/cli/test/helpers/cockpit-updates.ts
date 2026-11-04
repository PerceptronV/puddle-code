import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { afterEach, vi } from 'vitest';
import { PROTOCOL_VERSION, type HostUpdateCommand } from '@puddle/shared';
import { digest, ipcPath } from '@puddle/shared/node';
import { candidateFixture } from '../../../daemon/test/updates/preflight/helpers.js';
import { HostUpdateCoordinator } from '../../../daemon/src/updates/coordinator.js';
import type { UpdateInspection } from '../../../daemon/src/updates/preflight/inspection.js';
import { startHostControl } from '../../../daemon/src/security/control.js';
import { LeaseRegistry } from '../../../daemon/src/security/leases.js';
import { HostConnection } from '../../src/lib/auth/connection-authority.js';
import { CockpitHostUpdates } from '../../src/lib/host/updates/cockpit.js';
import type { Transport } from '../../src/lib/transport/transport.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Actual private leases/coordinator; metadata stages and supervisor outcomes are simulated. */
export async function cockpitUpdatesFixture(
  kind: 'local' | 'ssh' = 'local',
  minor: number = PROTOCOL_VERSION.minor,
) {
  const f = candidateFixture('daemon');
  vi.stubEnv('PUDDLE_HOME', f.home);
  const inspection: UpdateInspection = {
    fingerprint: digest('reviewed candidate'),
    connector: { state: 'absent', identity: null, blockers: [] },
    blockers: [],
    compatibility: { blockers: [], candidates: [], owners: [], inventory: null },
    capacity: { blockers: [], volumes: [] },
    impact: {
      fingerprint: digest('no interruption'),
      requiresInterruption: false,
      affected: { terminals: [], notebooks: [], compilation: [], programmes: [] },
    },
    supervision: {
      worker: { kind: 'systemd', domain: null },
      daemon: {
        kind: 'systemd',
        name: 'puddled.service',
        domain: null,
        pid: process.pid,
        invocation: 'a'.repeat(32),
        controlGroup: '/fixture/puddled.service',
        definition_path: null,
        definition_digest: digest('service'),
      },
      blockers: [],
    },
  };
  const inspect = vi.fn(async () => inspection);
  const dispatch = vi.fn(async (operation: typeof f.operation) => {
    const accepted = f.store.dispatch(operation);
    const worker = f.store.claimExecution(accepted, accepted.dispatch_id!, accepted.preflight!);
    try {
      worker.verifying();
      worker.complete(digest('simulated verified activation'));
    } finally {
      worker.release();
    }
  });
  const coordinator = new HostUpdateCoordinator({
    home: f.home,
    operations: f.store,
    inspection: { inspect },
    installedRuntime: () => f.capabilities.runtime,
    catalogue: () => ({
      observed_at: 1,
      daemon_version: '0.4.37',
      runtime_default: null,
      runtimes: { complete: true, versions: [] },
      releases: {
        repository: 'example/puddle',
        state: 'ready',
        checked_at: 1,
        succeeded_at: 1,
        latest: { version: '0.4.0', host_asset: true },
      },
    }),
    pauseDaemon: async () => ({
      release() {},
      outgoing: { pid: process.pid, controller: { id: randomUUID(), epoch: 1 } },
    }),
    dispatch,
  });
  const registry = new LeaseRegistry();
  cleanup.push(
    () => registry.dispose(),
    () => coordinator.close(),
  );
  const commands: HostUpdateCommand[] = [];
  let active: (() => boolean) | undefined;
  cleanup.push(
    await startHostControl(
      f.home,
      registry,
      () => ({
        port: 7434,
        version: { version: '0.4.37', protocol: { ...PROTOCOL_VERSION, minor } },
      }),
      (command, authorised) => {
        commands.push(command);
        active = authorised;
        return coordinator.execute(command, authorised);
      },
    ),
  );
  const transport: Transport = {
    kind,
    label: 'fixture-host',
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    openChannel: () => connect(ipcPath(f.home, 'host')),
    readFile: async () => null,
    copyTo: async () => {
      throw new Error('Fixture stages are supplied separately');
    },
    dispose() {},
  };
  const authority = new HostConnection(transport);
  cleanup.push(() => authority.close());
  await authority.establish();
  const control = new CockpitHostUpdates(transport, authority);
  const signal = new AbortController();
  return {
    ...f,
    control,
    authority,
    registry,
    commands,
    inspect,
    inspection,
    dispatch,
    transport,
    signal,
    active: () => active?.(),
    cleanup(close: () => void | Promise<void>) {
      cleanup.push(close);
    },
    request: (request: Parameters<typeof control.request>[0]) =>
      control.request(request, () => !signal.signal.aborted, signal.signal),
  };
}
