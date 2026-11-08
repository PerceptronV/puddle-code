import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeControllerWhenAvailable } from '../../../src/runtime/ownership/storage.js';
import { readNativeTurnJournal } from '../../../src/runtime/state/native-turns/records.js';
import {
  clients,
  controllers,
  prepare,
  launchOwner,
  waitForOwner,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it.each([false, true])(
  'retains headless completion independently of its controller (cancelled=%s)',
  async (cancelled) => {
    const f = prepare('headless');
    f.launch.main.env.PUDDLE_TEST_HEADLESS_NATIVE = '1';
    atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
    writeFileSync(
      join(f.home, 'headless-native.cjs'),
      `
    const fs = require('node:fs');
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => prompt += data);
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'headless-native' }));
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(join(f.home, 'release-turn'))})) return;
        clearInterval(timer);
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'reply:' + prompt } }));
        console.log(JSON.stringify({ type: 'turn.completed' }));
      }, 20);
    });
  `,
    );
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
    const origin = {
      huddleId: 'c'.repeat(32),
      executionId: randomUUID(),
      operationId: randomUUID(),
    };
    await client.request({
      t: 'start-turn',
      placement: placement(client),
      turn: 1,
      expected_ref: null,
      prompt: 'question',
      origin,
    });
    await expect
      .poll(() => readNativeTurnJournal(f.directory, f.launch.identity).records.length)
      .toBe(1);
    if (cancelled)
      await client.request({ t: 'cancel-turn', placement: placement(client), turn: 1 });
    client.close();
    f.controller.release();
    if (!cancelled) writeFileSync(join(f.home, 'release-turn'), 'finish');
    await expect
      .poll(() => readNativeTurnJournal(f.directory, f.launch.identity).records.length)
      .toBe(2);
    const controller = await acquireRuntimeControllerWhenAvailable(f.home);
    controllers.push(controller);
    const replacement = await RuntimeClient.open(f.home, f.launch, controller.record);
    clients.push(replacement);
    const response = await replacement.request({ t: 'native-turns', after: baseline.page.cursor });
    expect(response).toMatchObject({
      t: 'native-turns',
      page: {
        state: 'events',
        persistencePending: false,
        records: [
          {
            event: 'started',
            nativeTurnId: expect.stringMatching(/^command:/),
            agentSessionRef: 'headless-native',
            origin: { kind: 'automation', turn: 1, huddle: origin },
          },
          {
            event: cancelled ? 'interrupted' : 'completed',
            agentSessionRef: 'headless-native',
            origin: { kind: 'automation', turn: 1, huddle: origin },
            ...(cancelled ? {} : { reply: 'reply:question' }),
          },
        ],
      },
    });
  },
);
