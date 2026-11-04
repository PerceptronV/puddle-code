import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareHostRemoval, finishHostRemoval } from '../../../src/host/removal/coordinator.js';
import { restoreRemovedHostServices } from '../../../src/host/removal/restoration/execute.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeControllerWhenAvailable } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { removalHostFixture } from '../../helpers/removal-host.js';
import {
  launchOwner,
  waitForOwner,
  terminal,
  waitForSnapshot,
  clients,
  controllers,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it('retains a real runtime and shell variable through removal/restoration, then explicitly stops the reviewed owner', async () => {
  const f = runtimeDatabase();
  const host = removalHostFixture(f.home);
  const owner = launchOwner(f.home, f.launch.identity.runtime_id);
  const connections = new RuntimeConnections(
    f.home,
    f.runtimes,
    {
      connected: (id, client) => f.reconciler.attach(id, client),
      missing: (id) => f.reconciler.retire(id),
    },
    f.controller,
  );
  try {
    await waitForOwner(owner, f.directory);
    await connections.connect();
    const before = connections.get(f.binding.runtime_id)!;
    const original = terminal(before.state);
    await before.request({
      t: 'input',
      placement: placement(before),
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: "stty -echo; retained=removal-survived; printf 'ready-for-removal\\n'\n",
    });
    await waitForSnapshot(before, original.generation, 'ready-for-removal');
    await f.reconciler.close();
    await connections.close();
    f.controller.release();
    const review = await prepareHostRemoval(f.home, host.release, undefined, host.options);
    expect(review.owners).toHaveLength(1);
    expect(review.owners[0]!.stop_blocker).toBeNull();
    await finishHostRemoval(
      f.home,
      host.release,
      {
        id: review.id,
        fingerprint: review.fingerprint,
        attempt_id: randomUUID(),
        disposition: 'retain',
      },
      host.options,
    );
    expect(owner.child.exitCode).toBeNull();
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
    expect(existsSync(join(f.directory, 'launch.json'))).toBe(true);
    await restoreRemovedHostServices(f.home, host.release, review.id, {
      ...host.options,
      resume: false,
    });
    const controller = await acquireRuntimeControllerWhenAvailable(f.home);
    controllers.push(controller);
    const after = await RuntimeClient.open(f.home, f.launch, controller.record);
    clients.push(after);
    expect(terminal(after.state).pid).toBe(original.pid);
    await after.request({
      t: 'input',
      placement: placement(after),
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: 'printf \'%s\\n\' "$retained"\n',
    });
    await waitForSnapshot(after, original.generation, 'removal-survived');
    after.close();
    controller.release();
    const stop = await prepareHostRemoval(f.home, host.release, undefined, host.options);
    await finishHostRemoval(
      f.home,
      host.release,
      { id: stop.id, fingerprint: stop.fingerprint, attempt_id: randomUUID(), disposition: 'stop' },
      host.options,
    );
    expect(f.runtimes.live()).toEqual([]);
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(true);
    expect(existsSync(f.directory)).toBe(true);
  } finally {
    await f.reconciler.close();
    await connections.close();
    f.controller.release();
    f.db.close();
    host.close();
  }
});
