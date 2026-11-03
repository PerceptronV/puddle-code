import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../src/runtime/client.js';
import {
  acquireRuntimeController,
  readRuntimeJson,
  runtimeDirectory,
} from '../../src/runtime/storage.js';
import { readRuntimeJournal } from '../../src/runtime/journal.js';
import {
  clients,
  controllers,
  launchOwner,
  prepare,
  setup,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../helpers/runtime-fixture.js';

function hook(home: string, session: string) {
  return readRuntimeJson(join(home, `${session}.signals.json`)) as {
    url: string;
    nonce: string;
    port: number;
    pid: number;
    helpers: string;
    node: string;
    turnState: string;
  };
}
async function send(target: ReturnType<typeof hook>, body: Record<string, unknown>) {
  const response = await fetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: target.nonce, ...body }),
    signal: AbortSignal.timeout(5000),
  });
  await response.arrayBuffer();
  return response.status;
}
async function sidecar(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) });
  return (await response.json()) as { pid: number; counter: number };
}

describe('runtime-owned provider resources', () => {
  it('supplies owned helpers to both provider control and its PTY despite captured overrides', async () => {
    const { home, launch, controller, directory } = prepare('interactive');
    launch.capture_env = { enabled: true, values: { CAPTURED_FOR_TEST: 'seed' } };
    Object.assign(launch.main.env, {
      PUDDLE_AGENT_HELPER_DIR: '/invalid/captured/helpers',
      PUDDLE_AGENT_HELPER_NODE: '/invalid/captured/node',
      PUDDLE_AGENT_TURN_STATE_DIR: '/invalid/captured/state',
    });
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const owner = launchOwner(home, launch.identity.runtime_id, 'provider-owner.mjs');
    await waitForOwner(owner, directory);
    expect(hook(home, launch.identity.session_id)).toMatchObject({
      helpers: join(directory, 'helpers'),
      node: realpathSync(process.execPath),
      turnState: join(directory, 'hook-state'),
      captured: 'seed',
    });
    const client = await RuntimeClient.open(home, launch, controller.record);
    clients.push(client);
    const term = terminal(client.state);
    await client.request({
      t: 'input',
      term: 'agent',
      generation: term.generation,
      source: 'human',
      data: '"$PUDDLE_AGENT_HELPER_NODE" "$PUDDLE_AGENT_HELPER_DIR/puddle-signal.mjs"; printf \'captured-%s\\n\' "$CAPTURED_FOR_TEST"\n',
    });
    await waitForSnapshot(client, term.generation, 'pinned-runtime-helper');
    await waitForSnapshot(client, term.generation, 'captured-seed');
  });

  it.each(['interactive', 'headless'] as const)(
    'retains %s sidecars and exact lifecycle observations without a controller',
    async (mode) => {
      const { home, launch, controller, client, owner, directory } = await setup(mode);
      const original = terminal(client.state);
      const signal = hook(home, launch.identity.session_id);
      const before = await sidecar(signal.port);
      expect(client.state?.agent).toMatchObject({
        native_sync: 'full',
        sidecar_pids: [before.pid],
      });
      expect(client.state?.agent?.hidden_ports).toContain(signal.port);
      expect(client.state?.agent?.hidden_ports).toContain(Number(new URL(signal.url).port));
      client.close();
      controller.release();
      const first = {
        event: 'session_start',
        agent_session_ref: 'native-first',
        cwd: home,
        source: 'startup',
      };
      expect(await send(signal, first)).toBe(204);
      expect(await send(signal, { state: 'waiting_input' })).toBe(204);
      expect(
        await send(signal, {
          ...first,
          agent_session_ref: 'native-fork',
          parent_agent_session_ref: 'native-first',
          source: 'fork',
        }),
      ).toBe(204);
      const replacement = acquireRuntimeController(home);
      controllers.push(replacement);
      const next = await RuntimeClient.open(home, launch, replacement.record);
      clients.push(next);
      expect(terminal(next.state).pid).toBe(original.pid);
      expect(next.state?.agent).toMatchObject({
        native_sync: 'full',
        status: 'waiting_input',
        agent_session_ref: 'native-fork',
      });
      expect(await sidecar(signal.port)).toEqual({ pid: before.pid, counter: before.counter + 1 });
      const replay = await next.request({ t: 'events', after: 0 });
      if (replay.t !== 'events') throw new Error('Expected retained lifecycle events');
      expect(
        replay.page.events
          .filter((event) => event.t === 'native-lifecycle')
          .map((event) => event.lifecycle.agent_session_ref),
      ).toEqual(['native-first', 'native-fork']);
      expect(JSON.stringify(replay)).not.toContain(signal.nonce);
      const exited = once(owner.child, 'exit');
      await next.request({ t: 'stop' });
      await exited;
      expect(() => process.kill(before.pid, 0)).toThrow();
      expect(readRuntimeJournal(directory, launch.identity).events.at(-1)).toMatchObject({
        t: 'exit',
        term: 'agent',
      });
    },
  );

  it('rejects unrelated authority, browser origins and malformed lifecycle data', async () => {
    const { home, launch, client } = await setup('interactive');
    const signal = hook(home, launch.identity.session_id);
    expect(await send(signal, { nonce: 'x'.repeat(36), state: 'waiting_input' })).toBe(404);
    expect(await send(signal, { nonce: launch.secret, state: 'waiting_input' })).toBe(404);
    expect(await send(signal, { event: 'session_start', cwd: home, source: 'clear' })).toBe(404);
    expect(
      await send(signal, {
        event: 'session_start',
        agent_session_ref: 'x'.repeat(201),
        cwd: home,
        source: 'clear',
      }),
    ).toBe(404);
    const response = await fetch(signal.url, {
      method: 'POST',
      headers: { origin: 'http://localhost:7433', 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: signal.nonce, state: 'waiting_input' }),
    });
    expect(response.status).toBe(403);
    await response.arrayBuffer();
    await client.request({ t: 'inspect' });
    expect(client.state?.agent?.agent_session_ref).toBeNull();
  });

  it('stops a colliding incoming runtime while the existing conversation keeps running', async () => {
    const { home, launch, controller, client } = await setup('interactive');
    const first = hook(home, launch.identity.session_id);
    const native = {
      event: 'session_start',
      agent_session_ref: 'shared-native',
      cwd: home,
      source: 'resume',
    };
    expect(await send(first, native)).toBe(204);
    const competing = {
      ...launch,
      identity: {
        ...launch.identity,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
        session_id: randomUUID(),
      },
    };
    const directory = runtimeDirectory(home, competing.identity.runtime_id);
    atomicPrivateJson(join(directory, 'launch.json'), competing);
    const incoming = launchOwner(home, competing.identity.runtime_id, 'provider-owner.mjs');
    await waitForOwner(incoming, directory);
    const second = hook(home, competing.identity.session_id);
    const exited = once(incoming.child, 'exit');
    // The losing owner's socket can close while its hook receives the response.
    await send(second, native).catch(() => {});
    await exited;
    expect(readRuntimeJournal(directory, competing.identity).events).toContainEqual(
      expect.objectContaining({ t: 'native-collision', agent_session_ref: 'shared-native' }),
    );
    const next = await RuntimeClient.open(home, launch, controller.record);
    clients.push(next);
    expect(terminal(next.state).pid).toBe(terminal(client.state).pid);
    expect(await sidecar(first.port)).toMatchObject({ pid: first.pid });
    expect(() => process.kill(second.pid, 0)).toThrow();
  });

  it('falls back on unsupported interactive integration and refuses unsupported headless execution', async () => {
    for (const mode of ['interactive', 'headless'] as const) {
      const { home, launch, controller, directory } = prepare(mode);
      launch.main.env['PUDDLE_TEST_UNSUPPORTED'] = '1';
      atomicPrivateJson(join(directory, 'launch.json'), launch);
      const owner = launchOwner(home, launch.identity.runtime_id, 'provider-owner.mjs');
      if (mode === 'headless') {
        const [code] = await once(owner.child, 'exit');
        expect(code).not.toBe(0);
        expect(owner.errors()).toContain('Unsupported test version');
        expect(readRuntimeJson(join(directory, 'state.json'))).toMatchObject({
          state: 'failed',
          agent: { status: 'exited' },
        });
      } else {
        await waitForOwner(owner, directory);
        const client = await RuntimeClient.open(home, launch, controller.record);
        clients.push(client);
        expect(client.state?.agent?.native_sync).toBe('fallback');
        const term = terminal(client.state);
        await client.request({
          t: 'input',
          term: 'agent',
          generation: term.generation,
          source: 'human',
          data: "stty -echo; printf 'fallback-running\\n'\n",
        });
        await waitForSnapshot(client, term.generation, 'fallback-running');
      }
    }
  });
});
