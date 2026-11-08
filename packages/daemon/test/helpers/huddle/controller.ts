import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  huddleOwnerLaunchSchema,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { RuntimeReconciler } from '../../../src/runtime/controller/reconcile.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { runtimeDatabase } from '../runtime-database.js';
import { launchOwner, waitForOwner } from '../runtime-fixture.js';
import { schedulerSnapshot } from './scheduler.js';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('Huddle adoption observation timed out');
    await delay(20);
  }
}
const source = `import {HuddleNode} from 'puddlang/huddle'; import fs from 'node:fs';
export default HuddleNode({contract:'./node.json', async run({inputs}) {
  fs.appendFileSync(inputs.value + '/entered', 'x');
  while (!fs.existsSync(inputs.value + '/release')) await new Promise(r => setTimeout(r, 10));
  fs.writeFileSync(inputs.value + '/completed', 'x');
  return {completed: 42};
}});`;

export async function huddleControllerFixture(serviceLifetime = false) {
  const base = runtimeDatabase();
  let reconciler = base.reconciler;
  let connections: RuntimeConnections | undefined;
  const close = async () => {
    await connections?.close();
    await reconciler.close();
    base.db.close();
  };
  try {
    if (serviceLifetime) {
      base.launch.lifetime = 'service';
      atomicPrivateJson(join(base.directory, 'launch.json'), base.launch);
    }
    // One ordinary runtime remains live beside the new role throughout adoption.
    const ordinary = launchOwner(base.home, base.binding.runtime_id);
    await waitForOwner(ordinary, base.directory);
    const huddleId = randomBytes(16).toString('hex');
    const session = new HuddlePlacements(base.db).open({
      projectId: base.project.id,
      worktree: base.home,
      huddleId,
      branch: 'main',
      title: 'Review',
    }).session;
    const identity = {
      ...base.launch.identity,
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      session_id: session.id,
    };
    const snapshot = schedulerSnapshot(huddleId, source);
    const launch = huddleOwnerLaunchSchema.parse({
      format: 1,
      role: 'huddle',
      contract: 1,
      capabilities: HUDDLE_RUNTIME_CAPABILITIES,
      identity,
      scope: {
        hostId: 'fixture',
        runtimeId: identity.runtime_id,
        profileId: identity.profile_id,
        projectId: identity.project_id,
        sessionId: session.id,
        huddleId,
      },
      secret: randomBytes(32).toString('hex'),
      build: 'runtime-test',
      lifetime: 'service',
      initial: {
        id: randomUUID(),
        revision: snapshot.digest,
        worktree: identity.canonical_worktree_path,
        variables: {},
        bindings: {},
      },
    });
    const directory = runtimeDirectory(base.home, identity.runtime_id);
    new HuddleRevisionStore(base.home, identity.runtime_id, huddleId).publish(snapshot);
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const binding = base.runtimes.prepare({
      identity,
      build: launch.build,
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: directory,
      huddle: { id: huddleId, capabilities: launch.capabilities },
    });
    const owner = launchOwner(base.home, identity.runtime_id);
    await until(() => {
      if (owner.child.exitCode !== null) throw new Error(owner.errors());
      return existsSync(join(directory, 'huddle-owner.json'));
    });
    const handlers = () => ({
      connected: (id: string, client: Parameters<RuntimeReconciler['attach']>[1]) =>
        reconciler.attach(id, client),
      missing: (id: string) => reconciler.retire(id),
      huddleConnected: (id: string, client: Parameters<RuntimeReconciler['attachHuddle']>[1]) =>
        reconciler.attachHuddle(id, client),
      huddleMissing: (id: string) => reconciler.retire(id),
    });
    connections = new RuntimeConnections(base.home, base.runtimes, handlers(), base.controller);
    const attach = async () => {
      await connections!.connect();
      await until(async () => {
        await connections!.connectOwner(binding.runtime_id);
        return (
          !!connections!.getHuddle(binding.runtime_id) && reconciler.settled(binding.runtime_id)
        );
      });
    };
    await attach();
    return {
      ...base,
      ordinaryRuntimeId: base.binding.runtime_id,
      session,
      binding,
      owner,
      launch,
      directory,
      close,
      attach,
      get connections() {
        return connections!;
      },
      get reconciler() {
        return reconciler;
      },
      get client() {
        return connections!.getHuddle(binding.runtime_id)!;
      },
      async disconnect() {
        await connections!.close();
        await reconciler.close();
      },
      async replace() {
        reconciler = new RuntimeReconciler({ ...base, home: base.home });
        connections = new RuntimeConnections(base.home, base.runtimes, handlers());
        await attach();
      },
      async run() {
        const client = connections!.getHuddle(binding.runtime_id)!;
        await client.request({
          t: 'arm',
          expectedGeneration: client.state!.control.generation,
          autoStart: false,
        });
        await client.request({ t: 'run', node: 'run', eventId: 'once', data: base.home });
        await until(() => existsSync(join(base.home, 'entered')));
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
