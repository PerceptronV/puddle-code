import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  huddleOwnerLaunchSchema,
  type HuddleSpawnOperation,
} from '@puddle/shared';
import { atomicPrivateJson, ipcPath } from '@puddle/shared/node';
import { huddleSpawnServiceFixture } from './spawn-service.js';
import { spawnGraphSnapshot } from './spawn-graph.js';
import { until } from './controller.js';
import { launchOwner } from '../runtime-fixture.js';
import { HuddleOwnerClient } from '../../../src/runtime/huddle/transport/client.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';

/** Real independent source/node/agent processes; the test is the explicit private spawn dispatcher. */
export async function spawnOwnerFixture(enabled = true) {
  const capabilities = { ...HUDDLE_RUNTIME_CAPABILITIES, ...(enabled ? { spawns: 1 } : {}) };
  const f = huddleSpawnServiceFixture(120_000, capabilities);
  const binding = f.runtimes.get(f.scope.owner.runtime_id)!;
  const { snapshot, bindings } = spawnGraphSnapshot(binding.huddle_id!, f.request);
  const launch = huddleOwnerLaunchSchema.parse({
    format: 1,
    role: 'huddle',
    contract: 1,
    capabilities,
    identity: f.scope.owner,
    scope: {
      hostId: 'fixture',
      runtimeId: binding.runtime_id,
      profileId: f.profile.id,
      projectId: f.project.id,
      sessionId: f.scope.owner.session_id,
      huddleId: binding.huddle_id!,
    },
    secret: f.launch.secret,
    build: 'runtime-test',
    lifetime: 'service',
    initial: {
      id: randomUUID(),
      revision: snapshot.digest,
      worktree: f.scope.owner.canonical_worktree_path,
      variables: {},
      bindings,
    },
  });
  const directory = runtimeDirectory(f.home, binding.runtime_id);
  new HuddleRevisionStore(f.home, binding.runtime_id, binding.huddle_id!).publish(snapshot);
  atomicPrivateJson(join(directory, 'launch.json'), launch);
  const owner = launchOwner(f.home, binding.runtime_id);
  let client: HuddleOwnerClient | undefined;
  const close = async () => {
    if (client) {
      try {
        await client.request({ t: 'interrupt' });
        await client.request({ t: 'shutdown' });
      } catch {
        /* Fixture child tracking fences unresolved processes during teardown. */
      }
      client.close();
    }
    await f.close();
  };
  try {
    await until(() => {
      if (owner.child.exitCode !== null) throw new Error(owner.errors());
      return (
        existsSync(join(directory, 'huddle-owner.json')) &&
        existsSync(ipcPath(f.home, `runtime:${binding.runtime_id}`))
      );
    });
    const connect = async () => {
      client = await HuddleOwnerClient.open(f.home, launch, f.controller.record);
      return client;
    };
    await connect();
    const admit = async () => {
      const state = await client!.request({ t: 'inspect' });
      if (state.t !== 'state') throw new Error('No owner state');
      if (state.state.control.state !== 'armed')
        await client!.request({
          t: 'arm',
          expectedGeneration: state.state.control.generation,
          autoStart: false,
        });
      const accepted = await client!.request({
        t: 'run',
        node: 'run',
        eventId: randomUUID(),
        data: 'spawn fixture',
      });
      if (accepted.t !== 'run') throw new Error('No execution acceptance');
      return accepted.executionId;
    };
    return {
      ...f,
      supervisorRun: f.run,
      launch,
      snapshot,
      bindings,
      connect,
      close,
      admit,
      owner,
      get huddle() {
        return client!;
      },
      async run() {
        const executionId = await admit();
        let operation: HuddleSpawnOperation | undefined;
        await until(async () => {
          const page = await client!.request({ t: 'spawn-page', after: 0 });
          if (page.t !== 'spawn-page') throw new Error('No spawn page');
          operation = page.page.records.find(
            (row) => row.operation.scope.executionId === executionId,
          )?.operation;
          return !!operation;
        });
        return operation!;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
