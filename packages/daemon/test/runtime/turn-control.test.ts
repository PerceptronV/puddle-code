import { placement } from '../helpers/runtime-placement.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION, type RuntimeTurnResult } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { RuntimeClient } from '../../src/runtime/client.js';
import { readRuntimeFrames, writeRuntimeFrame } from '../../src/runtime/framing.js';
import { acquireRuntimeController, readRuntimeJson } from '../../src/runtime/storage.js';
import { readRuntimeJournal } from '../../src/runtime/journal.js';
import { clients, controllers, setup, terminal } from '../helpers/runtime-fixture.js';

async function completed(client: RuntimeClient, turn: number): Promise<RuntimeTurnResult> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await client.request({ t: 'turn-result', turn });
    if (response.t !== 'turn') throw new Error('Expected turn result');
    if (response.result.status !== 'running') return response.result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Provider did not finish its turn');
}

describe('runtime turn IPC', () => {
  it('binds admission to the native conversation and interrupts a pending turn on an exact switch', async () => {
    const { home, launch, client } = await setup('interactive');
    const hook = readRuntimeJson(join(home, `${launch.identity.session_id}.signals.json`)) as {
      url: string;
      nonce: string;
    };
    const signal = async (ref: string) => {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce: hook.nonce,
          event: 'session_start',
          agent_session_ref: ref,
          cwd: home,
          source: 'clear',
        }),
      });
      expect(response.status).toBe(204);
      await response.arrayBuffer();
    };
    await signal('native-first');
    await expect(
      client.request({
        placement: placement(client),
        t: 'start-turn',
        turn: 1,
        expected_ref: 'stale',
        prompt: 'question',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await client.request({
      placement: placement(client),
      t: 'start-turn',
      turn: 1,
      expected_ref: 'native-first',
      prompt: 'question',
    });
    await signal('native-second');
    expect(await completed(client, 1)).toMatchObject({
      status: 'interrupted',
      expected_ref: 'native-first',
    });
    await client.request({ t: 'inspect' });
    expect(client.state?.agent?.agent_session_ref).toBe('native-second');
  });

  it('recovers a turn whose admission response was lost without resubmitting it', async () => {
    const { home, launch, client, controller } = await setup('headless');
    client.close();
    const socket = connect(ipcPath(home, `runtime:${launch.identity.runtime_id}`));
    await once(socket, 'connect');
    const received = new Promise<number>((resolve, reject) => {
      const stop = readRuntimeFrames(
        socket,
        (value) => {
          const state = value as { t: string; state?: { command_cursor: number } };
          if (state.t !== 'state') return;
          // Stop reading before dispatch, so the admission response cannot reach
          // this controller even when the runtime answers immediately.
          socket.pause();
          stop();
          resolve(state.state!.command_cursor);
        },
        reject,
      );
      writeRuntimeFrame(socket, {
        t: 'hello',
        id: randomUUID(),
        protocol: RUNTIME_PROTOCOL_VERSION,
        runtime_id: launch.identity.runtime_id,
        incarnation: launch.identity.incarnation,
        secret: launch.secret,
        controller_id: controller.record.id,
        controller_epoch: controller.record.epoch,
      });
    });
    try {
      writeRuntimeFrame(socket, {
        placement: placement(client),
        t: 'start-turn',
        id: randomUUID(),
        sequence: (await received) + 1,
        turn: 1,
        expected_ref: null,
        prompt: 'survive disconnect',
      });
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          readRuntimeJson(join(home, `${launch.identity.session_id}.turns.json`));
          break;
        } catch {
          if (Date.now() > deadline) throw new Error('Provider did not receive its one request');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    } finally {
      socket.destroy();
    }
    controller.release();
    const replacement = acquireRuntimeController(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(next.state?.turn?.turn).toBe(1);
    expect(await completed(next, 1)).toMatchObject({
      status: 'completed',
      reply: 'reply:1:survive disconnect',
    });
    await expect(
      next.request({
        placement: placement(next),
        t: 'start-turn',
        turn: 1,
        expected_ref: null,
        prompt: 'survive disconnect',
      }),
    ).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(readRuntimeJson(join(home, `${launch.identity.session_id}.turns.json`))).toMatchObject({
      count: 1,
    });
    const replay = await next.request({ t: 'events', after: 0 });
    expect(replay).toMatchObject({
      t: 'events',
      page: {
        gap: false,
        events: expect.arrayContaining([
          expect.objectContaining({
            t: 'turn-finished',
            result: expect.objectContaining({ turn: 1, status: 'completed' }),
          }),
        ]),
      },
    });
  });

  it('allows exact cancellation and treats human input as takeover while preserving the agent', async () => {
    const { client } = await setup('interactive');
    const original = terminal(client.state);
    await client.request({
      placement: placement(client),
      t: 'start-turn',
      turn: 1,
      expected_ref: null,
      prompt: 'first',
    });
    await client.request({ placement: placement(client), t: 'cancel-turn', turn: 1 });
    expect(await completed(client, 1)).toMatchObject({ status: 'cancelled' });
    await client.request({
      placement: placement(client),
      t: 'start-turn',
      turn: 2,
      expected_ref: null,
      prompt: 'second',
    });
    await expect(
      client.request({ placement: placement(client), t: 'cancel-turn', turn: 1 }),
    ).rejects.toMatchObject({
      code: 'result_unavailable',
    });
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: ' ',
    });
    expect(await completed(client, 2)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('Human input'),
    });
    await client.request({ t: 'inspect' });
    expect(terminal(client.state).pid).toBe(original.pid);
  });

  it('retains interruption when the agent exits during an accepted turn', async () => {
    const { client, owner, directory, launch } = await setup('headless');
    await client.request({
      placement: placement(client),
      t: 'start-turn',
      turn: 1,
      expected_ref: null,
      prompt: 'unfinished',
    });
    const exited = once(owner.child, 'exit');
    await client.request({ placement: placement(client), t: 'stop' });
    await exited;
    expect(readRuntimeJournal(directory, launch.identity).events).toContainEqual(
      expect.objectContaining({
        t: 'turn-finished',
        result: expect.objectContaining({ turn: 1, status: 'interrupted' }),
      }),
    );
  });
});
