import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  completionHuddleTrigger,
  huddleOwnerLaunchSchema,
  HUDDLE_RUNTIME_CAPABILITIES,
  type HuddleCompletionBaseline,
  type RuntimeNativeTurnRecord,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { prepare, launchOwner } from '../runtime-fixture.js';
import { schedulerSnapshot } from './scheduler.js';
import { withTrigger } from './trigger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleOwnerClient } from '../../../src/runtime/huddle/transport/client.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';

const clients: HuddleOwnerClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.close()));
export async function untilCompletionOwner(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Completion owner observation timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function completionOwnerFixture(completion = true) {
  const base = prepare(),
    home = realpathSync(base.home);
  base.launch.identity.canonical_worktree_path = home;
  const huddleId = randomBytes(16).toString('hex'),
    session = randomUUID();
  const snapshot = schedulerSnapshot(
    huddleId,
    "import {HuddleNode} from 'puddlang/huddle'; export default HuddleNode({contract:'./node.json', async run({inputs}) { return {completed: inputs.value}; }});",
  );
  if (completion) withTrigger(snapshot, completionHuddleTrigger, { worktree: home, session });
  const root = join(home, '.puddle/huddle', huddleId);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'huddle.json'), snapshot.files['huddle.json']!);
  const capabilities = { ...HUDDLE_RUNTIME_CAPABILITIES };
  if (!completion) {
    delete capabilities.completionEvents;
    delete capabilities.completionPlans;
  }
  const launch = huddleOwnerLaunchSchema.parse({
    format: 1,
    role: 'huddle',
    contract: 1,
    capabilities,
    identity: base.launch.identity,
    scope: {
      hostId: 'fixture',
      runtimeId: base.launch.identity.runtime_id,
      profileId: base.launch.identity.profile_id,
      projectId: base.launch.identity.project_id,
      sessionId: base.launch.identity.session_id,
      huddleId,
    },
    secret: base.launch.secret,
    build: 'runtime-test',
    lifetime: 'service',
    initial: {
      id: randomUUID(),
      revision: snapshot.digest,
      worktree: home,
      variables: {},
      bindings: completion ? { run: { worktree: home, session } } : {},
    },
  });
  const directory = runtimeDirectory(home, launch.identity.runtime_id);
  new HuddleRevisionStore(home, launch.identity.runtime_id, huddleId).publish(snapshot);
  atomicPrivateJson(join(directory, 'launch.json'), launch);
  const owner = launchOwner(home, launch.identity.runtime_id);
  await untilCompletionOwner(() => {
    if (owner.child.exitCode !== null) throw new Error(owner.errors());
    return existsSync(join(directory, 'huddle-owner.json'));
  });
  const connect = async (controller = base.controller.record) => {
    const client = await HuddleOwnerClient.open(home, launch, controller);
    clients.push(client);
    return client;
  };
  let client: HuddleOwnerClient | undefined;
  await untilCompletionOwner(async () => {
    try {
      client = await connect();
      return true;
    } catch (error) {
      if (owner.child.exitCode !== null) throw error;
      return false;
    }
  });
  const baseline: HuddleCompletionBaseline = {
    node: 'run',
    cursor: { epoch: 'a'.repeat(32), sequence: 10 },
    target: {
      identity: {
        ...base.launch.identity,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
        session_id: session,
      },
      sessionId: session,
      segmentId: randomUUID(),
      nativeRef: 'native-ref',
    },
  };
  const record = (
    sequence: number,
    patch: Partial<RuntimeNativeTurnRecord> = {},
  ): RuntimeNativeTurnRecord => ({
    sequence,
    event: 'completed',
    observedAt: new Date().toISOString(),
    sessionId: session,
    segmentId: baseline.target.segmentId,
    agentSessionRef: baseline.target.nativeRef,
    nativeTurnId: `native-${sequence}`,
    reply: `reply ${sequence}`,
    origin: { kind: 'external' },
    ...patch,
  });
  const sources = async (target = client!) => {
    const result = await target.request({ t: 'completion-sources' });
    if (result.t !== 'completion-sources') throw new Error('Unexpected completion source response');
    return result.sources;
  };
  return {
    ...base,
    ...owner,
    home,
    launch,
    snapshot,
    baseline,
    record,
    client: client!,
    connect,
    sources,
  };
}
