import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import {
  acquireRuntimeControllerWhenAvailable,
  readRuntimeJson,
} from '../../../src/runtime/ownership/storage.js';
import { readNativeTurnJournal } from '../../../src/runtime/state/native-turns/records.js';
import {
  clients,
  controllers,
  prepare,
  launchOwner,
  waitForOwner,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

async function fixture() {
  const f = prepare('interactive');
  f.launch.main.env.PUDDLE_TEST_NATIVE_TURNS = '1';
  atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
  const owner = launchOwner(f.home, f.launch.identity.runtime_id, 'provider-owner.mjs');
  await waitForOwner(owner, f.directory);
  const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
  clients.push(client);
  const hook = readRuntimeJson(join(f.home, `${f.launch.identity.session_id}.signals.json`)) as {
    url: string;
    nonce: string;
  };
  const signal = async (event: object) => {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: hook.nonce, ...event }),
    });
    expect(response.status).toBe(204);
    await response.arrayBuffer();
  };
  const ref = 'observed-native';
  await signal({ event: 'session_start', agent_session_ref: ref, cwd: f.home, source: 'startup' });
  await client.request({ t: 'inspect' });
  expect(client.state?.agent?.native_turn_events).toBe(1);
  const baseline = await client.request({ t: 'native-turns', after: null });
  if (baseline.t !== 'native-turns') throw new Error('Missing native baseline');
  return { ...f, client, signal, ref, cursor: baseline.page.cursor };
}
it('retains native completion while the controller is absent and independently of ordinary event acknowledgement', async () => {
  const f = await fixture(),
    turn_id = randomUUID();
  f.client.close();
  f.controller.release();
  await f.signal({ event: 'turn_start', turn_id, agent_session_ref: f.ref });
  await f.signal({
    event: 'turn_complete',
    turn_id,
    agent_session_ref: f.ref,
    reply: 'human-started reply',
  });
  await expect
    .poll(() => readNativeTurnJournal(f.directory, f.launch.identity).records.length)
    .toBe(2);
  const controller = await acquireRuntimeControllerWhenAvailable(f.home);
  controllers.push(controller);
  const client = await RuntimeClient.open(f.home, f.launch, controller.record);
  clients.push(client);
  const ordinary = await client.request({ t: 'events', after: 0 });
  if (ordinary.t !== 'events') throw new Error('Missing ordinary events');
  await client.request({ t: 'ack-events', through: ordinary.page.through });
  const response = await client.request({ t: 'native-turns', after: f.cursor });
  expect(response).toMatchObject({
    t: 'native-turns',
    page: {
      state: 'events',
      persistencePending: false,
      records: [
        {
          event: 'started',
          nativeTurnId: turn_id,
          agentSessionRef: f.ref,
          origin: { kind: 'external' },
        },
        {
          event: 'completed',
          nativeTurnId: turn_id,
          reply: 'human-started reply',
          origin: { kind: 'external' },
        },
      ],
    },
  });
  expect(await client.request({ t: 'events', after: ordinary.page.through })).toMatchObject({
    t: 'events',
    page: { events: [] },
  });
});
it('retains the exact automated turn and originating huddle ids alongside the native completion', async () => {
  const f = await fixture(),
    origin = { huddleId: 'a'.repeat(32), executionId: randomUUID(), operationId: randomUUID() };
  await f.client.request({
    t: 'start-turn',
    placement: placement(f.client),
    turn: 1,
    expected_ref: f.ref,
    prompt: 'automated question',
    origin,
  });
  const { data } = readRuntimeJson(join(f.home, 'native-input.json')) as { data: string };
  const prompt = data.slice(6, -6),
    turn_id = /\[puddle-turn:([0-9a-f-]{36})\]$/.exec(prompt)![1]!;
  await f.signal({
    event: 'turn_start',
    agent_session_ref: f.ref,
    turn_id,
    prompt_hash: createHash('sha256').update(prompt).digest('hex'),
  });
  await f.signal({
    event: 'turn_complete',
    agent_session_ref: f.ref,
    turn_id,
    reply: 'automated reply',
  });
  const response = await f.client.request({ t: 'native-turns', after: f.cursor });
  expect(response).toMatchObject({
    t: 'native-turns',
    page: {
      state: 'events',
      persistencePending: false,
      records: [
        { event: 'started', origin: { kind: 'automation', turn: 1, huddle: origin } },
        { event: 'completed', origin: { kind: 'automation', turn: 1, huddle: origin } },
      ],
    },
  });
});

it.each([false, true])(
  'preserves cancellation attribution (before acknowledgement=%s) and reports an unmatched completion as a gap',
  async (beforeAck) => {
    const f = await fixture(),
      origin = { huddleId: 'b'.repeat(32), executionId: randomUUID(), operationId: randomUUID() };
    await f.client.request({
      t: 'start-turn',
      placement: placement(f.client),
      turn: 1,
      expected_ref: f.ref,
      prompt: 'cancel me',
      origin,
    });
    const { data } = readRuntimeJson(join(f.home, 'native-input.json')) as { data: string };
    const prompt = data.slice(6, -6),
      turn_id = /\[puddle-turn:([0-9a-f-]{36})\]$/.exec(prompt)![1]!;
    if (beforeAck)
      await f.client.request({ t: 'cancel-turn', placement: placement(f.client), turn: 1 });
    await f.signal({
      event: 'turn_start',
      agent_session_ref: f.ref,
      turn_id,
      prompt_hash: createHash('sha256').update(prompt).digest('hex'),
    });
    if (!beforeAck)
      await f.client.request({ t: 'cancel-turn', placement: placement(f.client), turn: 1 });
    await f.signal({ event: 'turn_complete', agent_session_ref: f.ref, turn_id, reply: 'late' });
    const response = await f.client.request({ t: 'native-turns', after: f.cursor });
    expect(response).toMatchObject({
      t: 'native-turns',
      page: {
        state: 'events',
        records: [
          { event: 'started', origin: { kind: 'automation', turn: 1, huddle: origin } },
          { event: 'interrupted', origin: { kind: 'automation', turn: 1, huddle: origin } },
        ],
      },
    });
    if (response.t !== 'native-turns') throw new Error('Missing native events');
    await f.signal({
      event: 'turn_complete',
      agent_session_ref: f.ref,
      turn_id: randomUUID(),
      reply: 'missing start',
    });
    expect(
      await f.client.request({ t: 'native-turns', after: response.page.cursor }),
    ).toMatchObject({
      t: 'native-turns',
      page: { state: 'gap', reason: 'retention', floor: 3 },
    });
  },
);

it('keeps native switches on their exact segments without assigning an unadopted conversation to the old placement', async () => {
  const f = await fixture(),
    oldTurn = randomUUID(),
    nextTurn = randomUUID();
  const oldSegment = f.client.state!.history.current.id;
  await f.signal({ event: 'turn_start', turn_id: oldTurn, agent_session_ref: f.ref });
  await f.signal({
    event: 'session_start',
    agent_session_ref: 'next-native',
    cwd: f.home,
    source: 'clear',
  });
  await f.signal({
    event: 'turn_complete',
    turn_id: oldTurn,
    agent_session_ref: f.ref,
    reply: 'stale completion',
  });
  await f.signal({ event: 'turn_start', turn_id: nextTurn, agent_session_ref: 'next-native' });
  await f.signal({
    event: 'turn_complete',
    turn_id: nextTurn,
    agent_session_ref: 'next-native',
    reply: 'new conversation',
  });
  await f.client.request({ t: 'inspect' });
  const nextSegment = f.client.state!.history.current.id;
  expect(nextSegment).not.toBe(oldSegment);
  expect(await f.client.request({ t: 'native-turns', after: f.cursor })).toMatchObject({
    t: 'native-turns',
    page: {
      state: 'events',
      records: [
        { event: 'started', segmentId: oldSegment, sessionId: f.launch.identity.session_id },
        { event: 'interrupted', segmentId: oldSegment, sessionId: f.launch.identity.session_id },
        { event: 'started', segmentId: nextSegment, sessionId: null },
        { event: 'completed', segmentId: nextSegment, sessionId: null, reply: 'new conversation' },
      ],
    },
  });
});
