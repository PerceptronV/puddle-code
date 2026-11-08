import { randomUUID } from 'node:crypto';
import { puddlangStartSchema } from '@puddle/shared';
import { PuddlangStore } from '../../../src/puddlang/store.js';
import { ProgrammeTurnStore } from '../../../src/puddlang/runtime-turn-store.js';
import { RuntimeProgrammeTurns } from '../../../src/runtime/controller/programme-turns.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { acquireRuntimeControllerWhenAvailable } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../runtime-database.js';
import { launchOwner, waitForOwner } from '../runtime-fixture.js';

export async function programmeOwnerFixture() {
  const f = runtimeDatabase('interactive');
  const owner = launchOwner(f.home, f.binding.runtime_id, 'provider-owner.mjs');
  await waitForOwner(owner, f.directory);
  f.controller.release();
  const connections = new RuntimeConnections(
    f.home,
    f.runtimes,
    {
      connected: (id, client) => f.reconciler.attach(id, client),
      missing: (id) => f.reconciler.retire(id),
    },
    await acquireRuntimeControllerWhenAvailable(f.home),
  );
  await connections.connect();
  const runs = new PuddlangStore(f.db);
  const input = puddlangStartSchema.parse({ id: randomUUID(), source: 'export default null;' });
  runs.create(f.profile.id, input);
  const scope = { runId: input.id, operationId: 1, profileId: f.profile.id };
  const operations = new ProgrammeTurnStore(f.db);
  const turns = new RuntimeProgrammeTurns(f.runtimes, connections, f.reconciler, operations);
  const client = connections.get(f.binding.runtime_id)!;
  return {
    ...f,
    client,
    connections,
    runs,
    scope,
    turns,
    operations,
    async close() {
      await f.reconciler.close();
      await connections.close();
      f.db.close();
    },
  };
}
