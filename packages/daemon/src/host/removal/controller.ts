import { join } from 'node:path';
import { hostUpdateTerminal } from '@puddle/shared';
import { readHostUpdateLedger } from '@puddle/shared/node/host-control';
import { openDatabase } from '../../db/db.js';
import { requireOwnedDatabase } from '../../db/paths.js';
import { RuntimeStore } from '../../db/stores/runtimes.js';
import { SessionStore } from '../../db/stores/sessions.js';
import { ConversationStore } from '../../db/stores/conversations.js';
import { EventStore } from '../../db/stores/events.js';
import { ProfileStore } from '../../db/stores/profiles.js';
import { acquireHostClaim } from '../../security/claims.js';
import { acquireRuntimeController } from '../../runtime/ownership/storage.js';
import { RuntimeConnections } from '../../runtime/transport/connections.js';
import { RuntimeReconciler } from '../../runtime/controller/reconcile.js';
import { RuntimeControls } from '../../runtime/controller/controls.js';
import { acquireInstallationLock } from '../installation/lock.js';
import { requireEndedUpdateWorker } from '../../updates/worker/lifetime.js';
import { readUpdateWorker } from '../../updates/worker/supervisor.js';
import { requireEndedUpdateRecoveryWorkers } from '../../updates/recovery/worker/records.js';
import { HOST_REMOVAL_RUNTIME_LIMIT, HostRuntimeRemoval } from './runtimes.js';
import { inspectRuntimeInventory } from '../../updates/preflight/compatibility.js';

/**
 * Trusted offline runtime phase of removal. The outgoing daemon must already have
 * released its controller; never take it over or migrate a database to uninstall.
 * The caller still owns supervisor removal, reference retention and filesystem purge.
 */
export async function withRemovalRuntimes<T>(
  home: string,
  action: (runtimes: HostRuntimeRemoval) => Promise<T>,
): Promise<T> {
  const claims: Array<{ release(): void }> = [];
  let controller: ReturnType<typeof acquireRuntimeController> | undefined;
  let installation: ReturnType<typeof acquireInstallationLock> | undefined;
  let db: ReturnType<typeof openDatabase> | undefined;
  let connections: RuntimeConnections | undefined;
  let reconciler: RuntimeReconciler | undefined;
  let controls: RuntimeControls | undefined;
  try {
    claims.push(acquireHostClaim(home, 'host-update-coordinator'));
    claims.push(acquireHostClaim(home, 'host-update-execution'));
    controller = acquireRuntimeController(home);
    installation = acquireInstallationLock(home);
    const ledger = readHostUpdateLedger(home);
    for (const operation of [ledger.current, ...ledger.history]) {
      if (!operation) continue;
      if (!hostUpdateTerminal(operation.phase))
        throw new Error('Resolve the host update before removal');
      if (operation.worker_id) {
        requireEndedUpdateWorker(home, readUpdateWorker(home, operation.id), operation);
        requireEndedUpdateRecoveryWorkers(home, operation);
      }
    }
    const file = join(home, 'puddle.db');
    requireOwnedDatabase(file);
    db = openDatabase(file, { migrate: false });
    const runtimes = new RuntimeStore(db);
    const rows = runtimes.live(HOST_REMOVAL_RUNTIME_LIMIT + 1);
    if (rows.length > HOST_REMOVAL_RUNTIME_LIMIT)
      throw new Error('Host removal runtime inventory exceeds its limit');
    const known = new Set(rows.map((row) => row.runtime_id));
    if ((await inspectRuntimeInventory(home, runtimes, known)).length)
      throw new Error('Host removal runtime inventory is unknown');
    const profiles = new ProfileStore(db);
    reconciler = new RuntimeReconciler({
      home,
      db,
      runtimes,
      sessions: new SessionStore(db),
      conversations: new ConversationStore(db),
      events: new EventStore(db),
      captureEnabled: (id) => profiles.getSettings(id).captureSessionEnv,
    });
    const observation = reconciler;
    connections = new RuntimeConnections(
      home,
      runtimes,
      {
        connected: (id, client) => observation.attach(id, client),
        missing: (id) => observation.retire(id),
      },
      controller,
    );
    controls = new RuntimeControls(runtimes, connections, reconciler);
    await connections.connect();
    return await action(new HostRuntimeRemoval({ runtimes, controls }));
  } finally {
    // Hold ownership and the database until every admitted operation has drained.
    // If drainage fails, do not release claims while a writer could still be active.
    await controls?.close();
    await reconciler?.close();
    await connections?.close();
    db?.close();
    controller?.release();
    installation?.release();
    for (const claim of claims.reverse()) claim.release();
  }
}
