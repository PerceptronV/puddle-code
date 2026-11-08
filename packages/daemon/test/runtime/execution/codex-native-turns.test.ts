import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeControllerWhenAvailable } from '../../../src/runtime/ownership/storage.js';
import { readNativeTurnJournal } from '../../../src/runtime/state/native-turns/records.js';
import { writeCodexFixture } from '../../helpers/agents/codex.js';
import {
  clients,
  controllers,
  prepare,
  launchOwner,
  waitForOwner,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it('retains external Codex turns without a controller and exact huddle attribution through the production bridge', async () => {
  const f = prepare('interactive');
  writeCodexFixture(f.home);
  f.launch.main.env.PUDDLE_TEST_CODEX_NATIVE = '1';
  f.launch.main.env.PATH = `${f.home}:/usr/bin:/bin`;
  atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
  const owner = launchOwner(f.home, f.launch.identity.runtime_id, 'provider-owner.mjs');
  await waitForOwner(owner, f.directory);
  const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
  clients.push(client);
  await expect
    .poll(async () => {
      await client.request({ t: 'inspect' });
      return client.state?.agent?.control_ready;
    })
    .toBe(true);
  expect(client.state!.agent!.native_turn_events).toBe(1);
  const baseline = await client.request({ t: 'native-turns', after: null });
  if (baseline.t !== 'native-turns') throw new Error('Missing native baseline');
  client.close();
  f.controller.release();
  atomicPrivateJson(join(f.home, 'codex-input.json'), [
    {
      method: 'fixture/batch',
      params: {
        messages: [
          {
            method: 'turn/started',
            params: { threadId: 'thread', turn: { id: 'human', status: 'inProgress' } },
          },
          {
            method: 'turn/completed',
            params: {
              threadId: 'thread',
              turn: {
                id: 'human',
                status: 'completed',
                items: [{ type: 'agentMessage', phase: 'final_answer', text: 'external answer' }],
              },
            },
          },
        ],
      },
    },
  ]);
  await expect
    .poll(() => readNativeTurnJournal(f.directory, f.launch.identity).records.length)
    .toBe(2);
  const controller = await acquireRuntimeControllerWhenAvailable(f.home);
  controllers.push(controller);
  const replacement = await RuntimeClient.open(f.home, f.launch, controller.record);
  clients.push(replacement);
  const origin = { huddleId: 'f'.repeat(32), executionId: randomUUID(), operationId: randomUUID() };
  await replacement.request({
    t: 'start-turn',
    placement: placement(replacement),
    turn: 1,
    expected_ref: 'thread',
    prompt: 'question',
    origin,
  });
  await expect
    .poll(() => readNativeTurnJournal(f.directory, f.launch.identity).records.length)
    .toBe(4);
  expect(
    await replacement.request({ t: 'native-turns', after: baseline.page.cursor }),
  ).toMatchObject({
    t: 'native-turns',
    page: {
      state: 'events',
      persistencePending: false,
      records: [
        {
          event: 'started',
          nativeTurnId: 'human',
          agentSessionRef: 'thread',
          origin: { kind: 'external' },
          sessionId: f.launch.identity.session_id,
        },
        {
          event: 'completed',
          nativeTurnId: 'human',
          reply: 'external answer',
          origin: { kind: 'external' },
        },
        {
          event: 'started',
          nativeTurnId: 'automated-1',
          origin: { kind: 'automation', turn: 1, huddle: origin },
        },
        {
          event: 'completed',
          nativeTurnId: 'automated-1',
          reply: 'answer',
          origin: { kind: 'automation', turn: 1, huddle: origin },
        },
      ],
    },
  });
});
