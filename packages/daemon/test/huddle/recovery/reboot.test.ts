import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  huddleOwnerLaunchSchema,
  sessionHuddleTrigger,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import { huddleLaunchFixture } from '../../helpers/huddle/launch.js';
import { until } from '../../helpers/huddle/controller.js';
import { huddleRetirementState } from '../../../src/runtime/huddle/ownership/retirement.js';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { admitManualHuddle } from '../../../src/runtime/huddle/control/manual.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import { sessionDefinitions } from '../../../src/runtime/huddle/triggers/sessions/definitions.js';
import { HuddleSessionFeed } from '../../../src/huddle/triggers/sessions/feed.js';
import { withHuddleReadSnapshot } from '../../../src/runtime/huddle/state/readers/database.js';

it('recovers one recorded owner after reboot, resumes queued work and subscriptions, and never replays interrupted work', async () => {
  const f = await huddleLaunchFixture(true);
  try {
    const identity = {
      ...f.launch.identity,
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      session_id: f.session.id,
    };
    const worktree = realpathSync(f.home);
    const snapshot = f.options.snapshot;
    snapshot.definition.nodes.push({
      id: 'sessions',
      source: { kind: 'builtin', component: sessionHuddleTrigger.id, version: 1 },
      parameters: { worktree: { kind: 'literal', value: worktree } },
      concurrency: 1,
    });
    snapshot.components.sessions = sessionHuddleTrigger;
    snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
    snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
    const boot = await readHostBootIdentity();
    expect(boot).not.toBeNull();
    const launch = huddleOwnerLaunchSchema.parse({
      format: 1,
      role: 'huddle',
      contract: 1,
      capabilities: HUDDLE_RUNTIME_CAPABILITIES,
      identity,
      secret: randomBytes(32).toString('hex'),
      build: '1.2.3',
      lifetime: 'service',
      boot_id: boot,
      scope: {
        hostId: 'fixture',
        runtimeId: identity.runtime_id,
        profileId: identity.profile_id,
        projectId: identity.project_id,
        sessionId: identity.session_id,
        huddleId: snapshot.definition.id,
      },
      initial: {
        id: randomUUID(),
        revision: snapshot.digest,
        worktree,
        variables: {},
        bindings: { sessions: { worktree } },
      },
    });
    const directory = runtimeDirectory(f.home, identity.runtime_id);
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    f.runtimes.prepare({
      identity,
      build: '1.2.3',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: f.installed.release,
      huddle: { id: snapshot.definition.id, capabilities: launch.capabilities },
    });
    const target = { runtimeId: identity.runtime_id, incarnation: identity.incarnation };
    await expect(f.launcher.recoverHuddle(f.session.id, target, () => true)).rejects.toThrow(
      /earlier host boot/,
    );
    // Model a previous boot's durable state without killing or rebooting this host.
    launch.boot_id = randomUUID();
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const ledger = new HuddleLedger(f.home, launch.scope);
    const revisions = new HuddleRevisionStore(f.home, identity.runtime_id, launch.scope.huddleId);
    let interrupted: string, queued: string, operation: string;
    const cursor = new HuddleSessionFeed(f.db).checkpoint();
    try {
      new HuddleRevisionController(ledger, revisions).apply(snapshot, launch.initial, 0);
      ledger.activations.setIntent(ledger.activations.current().generation, 'armed', false);
      const activation = ledger.activations.get(launch.initial.id);
      ledger.sessions.initialise(sessionDefinitions(snapshot, activation), activation, cursor);
      interrupted = admitManualHuddle(ledger, revisions, 'run', 'running', f.home).execution.id;
      ledger.executions.start(interrupted);
      const invocationId = randomUUID();
      ledger.invocations.queue({
        id: invocationId,
        executionId: interrupted,
        revision: snapshot.digest,
        node: 'worker',
        activation: 'fixture',
        iteration: 0,
        inputs: { value: worktree },
      });
      ledger.invocations.start(invocationId);
      operation = randomUUID();
      // Legacy intent has no caller row; recovery must derive it from the original launch.
      ledger.operations.prepare({
        id: operation,
        invocationId,
        kind: 'ask',
        target: {},
        input: {},
      });
      ledger.operations.dispatch(operation);
      queued = admitManualHuddle(ledger, revisions, 'run', 'queued', f.home).execution.id;
    } finally {
      ledger.close();
    }
    writeFileSync(join(f.home, 'release'), 'go');
    await f.launcher.recoverHuddle(f.session.id, target, () => true);
    const replacement = f.runtimes.ownerOf(f.session.id)!;
    expect(replacement.runtime_id).not.toBe(identity.runtime_id);
    const replacementLaunch = huddleOwnerLaunchSchema.parse(
      JSON.parse(
        readFileSync(join(f.home, 'runtimes', replacement.runtime_id, 'launch.json'), 'utf8'),
      ),
    );
    expect(
      huddleRetirementState({ ...replacement, event_cursor: -1 }, replacementLaunch, null, null)
        .clean,
    ).toBe(false);
    const client = f.connections.getHuddle(replacement.runtime_id)!;
    await until(async () => {
      const result = await client.request({ t: 'records', collection: 'executions', after: 0 });
      return (
        result.t === 'records' &&
        result.rows.some((row) => row.id === queued && JSON.parse(row.body).state === 'completed')
      );
    });
    const records = await client.request({ t: 'records', collection: 'executions', after: 0 });
    expect(records.t).toBe('records');
    if (records.t !== 'records') throw new Error('Missing history');
    expect(records.rows.map((row) => [row.id, JSON.parse(row.body).state])).toEqual([
      [interrupted, 'interrupted'],
      [queued, 'completed'],
    ]);
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    const sources = await client.request({ t: 'session-sources' });
    expect(sources).toMatchObject({
      t: 'session-sources',
      sources: [{ node: 'sessions', cursor }],
    });
    const retained = withHuddleReadSnapshot(
      f.home,
      client.state!.scope,
      (db) =>
        db
          .prepare('SELECT collection, body FROM records WHERE id = ? ORDER BY collection')
          .all(operation) as Array<{ collection: string; body: string }>,
    );
    expect(
      JSON.parse(retained.find((row) => row.collection === 'operation-origins')!.body).owner,
    ).toEqual(identity);
    expect(JSON.parse(retained.find((row) => row.collection === 'operations')!.body)).toMatchObject(
      { state: 'unknown', consumed: true },
    );
    expect(f.runtimes.get(identity.runtime_id)?.state).toBe('exited');
    expect(f.run).toHaveBeenCalledTimes(1);
    await expect(f.launcher.recoverHuddle(f.session.id, target, () => true)).rejects.toThrow(
      /earlier host boot/,
    );
    expect(f.run).toHaveBeenCalledTimes(1);
    await f.controls.huddles.stop(f.session.id, () => true);
  } finally {
    await f.close();
  }
});
