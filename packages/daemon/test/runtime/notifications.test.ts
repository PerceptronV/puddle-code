import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ipcPath, listenPrivate } from '@puddle/shared/node';
import { runtimeStateSchema, type NotificationContent } from '@puddle/shared';
import { RuntimeClient } from '../../src/runtime/client.js';
import { readRuntimeJson } from '../../src/runtime/storage.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import {
  clients,
  launchOwner,
  setup,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../helpers/runtime-fixture.js';
import { waitFor } from '../helpers/daemon-fixtures.js';
import { placement } from '../helpers/runtime-placement.js';

it('reads a bounded preview only for the current exact attention condition', async () => {
  const f = await setup('interactive');
  const main = terminal(f.client.state);
  await f.client.request({
    t: 'input',
    placement: placement(f.client),
    term: 'agent',
    generation: main.generation,
    source: 'human',
    data: "stty -echo; printf 'current-attention-preview\\n'\n",
  });
  await waitForSnapshot(f.client, main.generation, 'current-attention-preview');
  const hook = readRuntimeJson(join(f.home, `${f.launch.identity.session_id}.signals.json`)) as {
    url: string;
    nonce: string;
  };
  const signal = async (state: string) => {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: hook.nonce, state }),
    });
    expect(response.status).toBe(204);
    await response.arrayBuffer();
  };
  await signal('waiting_input');
  await f.client.request({ t: 'inspect' });
  const request = {
    t: 'attention-preview' as const,
    placement: placement(f.client),
    attention_id: f.client.state!.attention!.id,
  };
  const preview = await f.client.request(request);
  expect(preview).toMatchObject({
    t: 'attention-preview',
    attention_id: request.attention_id,
    text: expect.stringContaining('current-attention-preview'),
  });
  await signal('working');
  await expect(f.client.request(request)).rejects.toMatchObject({ code: 'result_unavailable' });
});

it.each([false, true])(
  'delivers only current offline attention through real daemon replacements (natural exit=%s)',
  async (naturalExit) => {
    const f = runtimeDatabase('interactive');
    const deliveries: Array<{ id: string; content: NotificationContent }> = [];
    // This private, isolated connector sink records delivery without sending any push.
    const sink = await listenPrivate(ipcPath(f.home, `remote-${f.profile.id}`), (socket) => {
      let bytes = '';
      socket.on('data', (chunk) => {
        bytes += chunk.toString();
        if (!bytes.includes('\n')) return;
        deliveries.push(JSON.parse(bytes) as (typeof deliveries)[number]);
        socket.end('{}\n');
      });
    });
    let daemon: ReturnType<typeof launchOwner> | undefined;
    let ready: { port: number; token: string } | undefined;
    const start = async () => {
      rmSync(join(f.home, 'test-daemon-ready.json'), { force: true });
      daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
      await waitFor(() => {
        if (daemon!.child.exitCode !== null) throw new Error(daemon!.errors());
        try {
          ready = readRuntimeJson(join(f.home, 'test-daemon-ready.json')) as typeof ready;
          return true;
        } catch {
          return false;
        }
      });
    };
    const stop = async () => {
      const exited = once(daemon!.child, 'exit');
      daemon!.child.kill('SIGTERM');
      expect((await exited)[0]).toBe(0);
    };
    try {
      const owner = launchOwner(f.home, f.binding.runtime_id, 'provider-owner.mjs');
      await waitForOwner(owner, f.directory);
      const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
      clients.push(client);
      const original = terminal(client.state);
      if (naturalExit)
        await client.request({
          t: 'input',
          placement: placement(client),
          term: 'agent',
          generation: original.generation,
          source: 'human',
          data: 'while [ ! -f "$HOME/test-natural-exit" ]; do sleep 0.05; done; exit 0\n',
        });
      const hook = readRuntimeJson(join(f.home, `${f.session.id}.signals.json`)) as {
        url: string;
        nonce: string;
      };
      const signal = async (data: object) => {
        const response = await fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce: hook.nonce, ...data }),
        });
        expect(response.status).toBe(204);
        await response.arrayBuffer();
      };
      const native = (ref: string, source: string) =>
        signal({ event: 'session_start', agent_session_ref: ref, cwd: f.home, source });
      await native('first', 'startup');
      await signal({ state: 'waiting_input' });
      await client.request({ t: 'inspect' });
      const obsolete = client.state!.attention!.id;
      await signal({ state: 'working' });
      await native('second', 'clear');
      await client.request({ t: 'inspect' });
      expect(client.state?.attention).toBeNull();
      await signal({ state: 'waiting_input' });
      await client.request({ t: 'inspect' });
      let attention = client.state!.attention!;
      expect(attention.id).not.toBe(obsolete);
      if (naturalExit) {
        // Native switching is not yet bound by a daemon; the child exits itself.
        const exited = once(owner.child, 'exit');
        writeFileSync(join(f.home, 'test-natural-exit'), '');
        await exited;
        attention = runtimeStateSchema.parse(
          readRuntimeJson(join(f.directory, 'state.json')),
        ).attention!;
        expect(attention.reason).toBe('exited');
      }
      client.close();
      f.controller.release();
      await start();
      await waitFor(() => deliveries.length === 1);
      const active = f.runtimes.get(f.binding.runtime_id)!.active_session_id;
      expect(active).not.toBe(f.session.id);
      expect(deliveries[0]).toMatchObject({
        id: attention.id,
        content: { session: active, project: f.project.id },
      });
      expect(f.reconciler.observations.get(f.binding.runtime_id)?.terminals[0]?.pid).toBe(
        naturalExit ? null : original.pid,
      );
      expect(f.db.prepare('SELECT delivered_id FROM runtime_attention').get()).toEqual({
        delivered_id: attention.id,
      });
      await stop();
      await start();
      // A committed delivery survives daemon replacement; current state alone is no new alert.
      expect(f.db.prepare('SELECT delivered_id FROM runtime_attention').get()).toEqual({
        delivered_id: attention.id,
      });
      if (!naturalExit) {
        await signal({ state: 'working' });
        await signal({ state: 'waiting_input' });
        await waitFor(() => deliveries.length === 2);
        expect(new Set(deliveries.map((event) => event.id)).size).toBe(2);
        const response = await fetch(
          `http://127.0.0.1:${ready!.port}/api/sessions/${active}/kill`,
          { method: 'POST', headers: { authorization: `Bearer ${ready!.token}` } },
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        await waitFor(() => f.runtimes.get(f.binding.runtime_id)?.state === 'exited');
        expect(f.db.prepare('SELECT attention FROM runtime_attention').get()).toEqual({
          attention: null,
        });
      }
      await stop();
      expect(deliveries).toHaveLength(naturalExit ? 1 : 2);
      expect(
        f.sessions
          .list()
          .flatMap((session) => f.events.list(session.id))
          .some((event) => event.type.includes('notification')),
      ).toBe(false);
    } finally {
      if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null)
        await stop();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
      await f.reconciler.close();
      f.db.close();
    }
  },
);
