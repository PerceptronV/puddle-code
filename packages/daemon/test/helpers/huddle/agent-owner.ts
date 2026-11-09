import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  huddleOwnerLaunchSchema,
  type HuddleAgentOperation,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../src/huddle/definitions/capture.js';
import { atomicPrivateJson, ipcPath } from '@puddle/shared/node';
import { programmeOwnerFixture } from '../runtime/programme-owner.js';
import { huddleTurnScope } from './agent-turns.js';
import { agentGraphSnapshot } from './agent-graph.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleOwnerClient } from '../../../src/runtime/huddle/transport/client.js';
import { HuddleTurnStore } from '../../../src/huddle/operations/turns/store.js';
import { HuddleAgentTurns } from '../../../src/huddle/operations/turns/service.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { launchOwner } from '../runtime-fixture.js';
import { until } from './controller.js';

/** Real isolated huddle/script/agent owners; the test explicitly drives the private operation controller. */
export async function agentOwnerFixture(
  legacy = false,
  graph?: (
    fixture: Awaited<ReturnType<typeof programmeOwnerFixture>>,
    scope: ReturnType<typeof huddleTurnScope>,
  ) => Promise<{
    snapshot: HuddleDefinitionSnapshot;
    bindings: HuddleRevisionActivation['bindings'];
  }>,
) {
  const f = await programmeOwnerFixture();
  const capabilities = { ...HUDDLE_RUNTIME_CAPABILITIES };
  if (legacy) {
    delete capabilities.operations;
    delete capabilities.spawns;
    delete capabilities.lifecycle;
    delete capabilities.nativeFeedback;
  }
  const scope = huddleTurnScope(f, capabilities);
  const binding = f.runtimes.get(scope.owner.runtime_id)!;
  const { snapshot, bindings } = graph
    ? await graph(f, scope)
    : agentGraphSnapshot(binding.huddle_id!, scope.target);
  const launch = huddleOwnerLaunchSchema.parse({
    format: 1,
    role: 'huddle',
    contract: 1,
    capabilities,
    identity: scope.owner,
    scope: {
      hostId: 'fixture',
      runtimeId: scope.owner.runtime_id,
      profileId: f.profile.id,
      projectId: f.project.id,
      sessionId: scope.owner.session_id,
      huddleId: binding.huddle_id,
    },
    secret: f.launch.secret,
    build: 'runtime-test',
    lifetime: 'service',
    initial: {
      id: randomUUID(),
      revision: snapshot.digest,
      worktree: scope.owner.canonical_worktree_path,
      variables: {},
      bindings,
    },
  });
  const directory = runtimeDirectory(f.home, scope.owner.runtime_id);
  new HuddleRevisionStore(f.home, scope.owner.runtime_id, binding.huddle_id!).publish(snapshot);
  atomicPrivateJson(join(directory, 'launch.json'), launch);
  const owner = launchOwner(f.home, scope.owner.runtime_id);
  let client: HuddleOwnerClient | undefined;
  const close = async () => {
    if (client) {
      try {
        await client.request({ t: 'interrupt' });
      } catch {
        /* fixture teardown fences its children */
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
        existsSync(ipcPath(f.home, `runtime:${scope.owner.runtime_id}`))
      );
    });
    const connect = async () => {
      await until(async () => {
        await f.connections.connectOwner(scope.owner.runtime_id);
        client = f.connections.getHuddle(scope.owner.runtime_id) ?? undefined;
        return !!client;
      });
      await f.reconciler.attachHuddle(scope.owner.runtime_id, client!);
      return client;
    };
    await connect();
    const turns = new HuddleAgentTurns(f.turns, new HuddleTurnStore(f.db));
    return {
      ...f,
      launch,
      scope,
      turns,
      programmeTurns: f.turns,
      close,
      connect,
      get huddle() {
        return client!;
      },
      async run(prompt: string) {
        const state = await client!.request({ t: 'inspect' });
        if (state.t !== 'state') throw new Error('No owner state');
        await client!.request({
          t: 'arm',
          expectedGeneration: state.state.control.generation,
          autoStart: false,
        });
        const response = await client!.request({
          t: 'run',
          node: 'run',
          eventId: randomUUID(),
          data: prompt,
        });
        if (response.t !== 'run') throw new Error('No execution acceptance');
        let operation: HuddleAgentOperation | undefined;
        await until(async () => {
          const page = await client!.request({ t: 'operation-page', after: 0 });
          if (page.t !== 'operation-page') throw new Error('No operation page');
          operation = page.page.records.find(
            ({ operation }) => operation.scope.executionId === response.executionId,
          )?.operation;
          return !!operation;
        });
        return operation!;
      },
      async execute(operation: HuddleAgentOperation) {
        const claimed = await client!.request({
          t: 'operation-claim',
          operationId: operation.scope.operationId,
        });
        if (claimed.t !== 'operation-claim' || !claimed.dispatch)
          throw new Error('No dispatch grant');
        await turns.ask(
          operation.scope,
          operation.request,
          new AbortController().signal,
          () => true,
        );
        const observed = turns.observe(operation.scope, operation.request, () => true);
        if (!observed.result || !observed.receipt) throw new Error('No retained outcome');
        return { turn: observed.result, receipt: observed.receipt };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
