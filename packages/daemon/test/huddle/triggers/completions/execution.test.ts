import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { completionHuddleTrigger } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { huddleExecutionFixture } from '../../../helpers/huddle/execution.js';
import { withTrigger } from '../../../helpers/huddle/trigger.js';
import { until } from '../../../helpers/huddle/controller.js';
import { launchOwner, waitForOwner } from '../../../helpers/runtime-fixture.js';
import { readRuntimeJson } from '../../../../src/runtime/ownership/storage.js';
import { HuddleCompletionDispatcher } from '../../../../src/huddle/triggers/completions/dispatcher.js';

it('starts a saved completion graph through HTTP, gates old releases and resumes from a fresh native baseline', async () => {
  const f = await huddleExecutionFixture('interactive');
  const dispatcher = new HuddleCompletionDispatcher(f);
  try {
    f.launch.main.env.PUDDLE_TEST_NATIVE_TURNS = '1';
    atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
    const native = launchOwner(f.home, f.launch.identity.runtime_id, 'provider-owner.mjs');
    await waitForOwner(native, f.directory);
    const hook = readRuntimeJson(join(f.home, `${f.launch.identity.session_id}.signals.json`)) as {
      url: string;
      nonce: string;
    };
    const ref = 'huddle-observed-native';
    const signal = async (event: object) => {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: hook.nonce, agent_session_ref: ref, ...event }),
      });
      expect(response.status).toBe(204);
      await response.arrayBuffer();
    };
    await signal({ event: 'session_start', cwd: f.home, source: 'startup' });
    await f.connections.connectOwner(f.launch.identity.runtime_id);
    await until(() => f.reconciler.settled(f.launch.identity.runtime_id));
    const watched = f.runtimes.get(f.launch.identity.runtime_id)!.active_session_id;
    expect(f.sessions.get(watched).agent_session_ref).toBe(ref);
    const snapshot = withTrigger(f.options.snapshot, completionHuddleTrigger, {
      worktree: f.home,
      session: watched,
    });
    writeFileSync(join(f.root, 'huddle.json'), snapshot.files['huddle.json']!);
    writeFileSync(
      join(f.root, 'nodes/example/run.ts'),
      "import {HuddleNode} from 'puddlang/huddle'; export default HuddleNode({contract:'./node.json', async run({inputs}) { return {completed: inputs.value}; }});",
    );
    const document = await f.source();
    expect(document.components.run!.id).toBe(completionHuddleTrigger.id);
    const metadataPath = join(f.installed.release, 'RUNTIME_CAPABILITIES.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    delete metadata.roles.huddle.nativeFeedback;
    for (const capability of ['completionEvents', 'completionPlans']) {
      delete metadata.roles.huddle[capability];
      writeFileSync(metadataPath, JSON.stringify(metadata));
      const refused = await f.request('start', { expected_digest: document.digest, variables: {} });
      expect(refused.body.error.code, JSON.stringify(refused)).toBe('huddle_execution_unsupported');
      expect(f.run).not.toHaveBeenCalled();
      metadata.roles.huddle[capability] = 1;
    }
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const started = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    dispatcher.start();
    let target = started.body.owner.target;
    const history = {
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      collection: 'executions',
      after: 0,
    };
    const completeTurn = async (reply: string) => {
      const turn_id = randomUUID();
      await signal({ event: 'turn_start', turn_id });
      await signal({ event: 'turn_complete', turn_id, reply });
      return turn_id;
    };
    const completed = async (count: number) =>
      until(async () => {
        const result = await f.request('history', history);
        expect(result.status).toBe(200);
        return (
          result.body.records.length === count &&
          result.body.records.every(
            (row: { record: { state: string } }) => row.record.state === 'completed',
          )
        );
      });
    const turn = await completeTurn('reply from the native source');
    await completed(1);
    const execution = (await f.request('history', history)).body.records[0].record;
    const invocations = await f.request('history', {
      ...history,
      collection: 'invocations',
      parent: execution.id,
    });
    expect(
      invocations.body.records.some(
        (row: { record: { result?: { completed?: { nativeTurnId: string; reply: string } } } }) =>
          row.record.result?.completed?.nativeTurnId === turn &&
          row.record.result.completed.reply === 'reply from the native source',
      ),
    ).toBe(true);
    const interrupted = await f.request('interrupt', { target });
    expect(interrupted.status).toBe(200);
    await completeTurn('while paused');
    const resumed = await f.request('rearm', { target: interrupted.body.owner.target });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    target = resumed.body.owner.target;
    await completeTurn('after resume');
    await completed(2);
    expect((await f.request('stop', { target })).status).toBe(200);
  } finally {
    await dispatcher.close();
    await f.close();
  }
});
