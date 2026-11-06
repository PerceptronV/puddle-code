import WebSocket from 'ws';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sessionPortsResponseSchema, type WsServerMessage } from '@puddle/shared';
import { secret } from '@puddle/shared/node';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import {
  acquireRuntimeControllerWhenAvailable,
  readRuntimeJson,
} from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import {
  clients,
  controllers,
  launchOwner,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function viewer(port: number, token: string, session: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: WsServerMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as WsServerMessage));
  await once(ws, 'open');
  const send = (message: object) => ws.send(JSON.stringify(message));
  send({ t: 'auth', token, resource: secret() });
  await until(() => messages.some((m) => m.t === 'authenticated'), 'Viewer was not authenticated');
  send({ t: 'attach', session, term: 'agent', cols: 90, rows: 25 });
  await until(
    () => messages.some((m) => m.t === 'replay'),
    `No snapshot: ${JSON.stringify(messages)}`,
  );
  return {
    ws,
    messages,
    send,
    text: () =>
      messages.flatMap((m) => (m.t === 'output' || m.t === 'replay' ? [m.data] : [])).join(''),
    input: (data: string) => send({ t: 'stdin', session, term: 'agent', data }),
  };
}

it('routes the real daemon WebSocket to surviving PTYs and immutable native history across restarts', async () => {
  const f = runtimeDatabase('interactive');
  const sockets: WebSocket[] = [];
  try {
    const runtime = launchOwner(f.home, f.binding.runtime_id, 'provider-owner.mjs');
    await waitForOwner(runtime, f.directory);
    const original = await RuntimeClient.open(f.home, f.launch, f.controller.record);
    clients.push(original);
    const main = terminal(original.state);
    const hook = readRuntimeJson(join(f.home, `${f.session.id}.signals.json`)) as {
      url: string;
      nonce: string;
      port: number;
    };
    const signal = async (ref: string, source: 'startup' | 'resume') => {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce: hook.nonce,
          event: 'session_start',
          agent_session_ref: ref,
          cwd: f.home,
          source,
        }),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(204);
    };
    await signal('first', 'startup');
    await original.request({
      t: 'input',
      placement: placement(original),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: "stty -echo; survivor=kept; printf 'initial-%s\\n' screen\n",
    });
    await waitForSnapshot(original, main.generation, 'initial-screen');
    const serverFile = join(f.home, 'test-preview-server.json');
    await original.request({
      t: 'spawn-shell',
      placement: placement(original),
      term: 'shell-1',
      command: {
        file: process.execPath,
        args: [
          '-e',
          `const server = require('node:http').createServer((req, res) => res.end('surviving-preview'));
          server.listen(0, '127.0.0.1', () => require('node:fs').writeFileSync(
            ${JSON.stringify(serverFile)}, JSON.stringify({ port: server.address().port, pid: process.pid }), { mode: 0o600 }));`,
        ],
        cwd: f.home,
        env: {},
        cols: 80,
        rows: 24,
      },
    });
    let preview: { port: number; pid: number } | undefined;
    await until(() => {
      try {
        preview = readRuntimeJson(serverFile) as typeof preview;
        return true;
      } catch {
        return false;
      }
    }, 'Preview server did not start');
    original.close();
    f.controller.release();
    for (let pass = 0; pass < 3; pass++) {
      if (pass === 2) {
        const controller = await acquireRuntimeControllerWhenAvailable(f.home);
        controllers.push(controller);
        const client = await RuntimeClient.open(f.home, f.launch, controller.record);
        clients.push(client);
        const ended = once(runtime.child, 'exit');
        await client.request({ t: 'stop', placement: placement(client) });
        await ended;
        client.close();
        controller.release();
      }
      rmSync(join(f.home, 'test-daemon-ready.json'), { force: true });
      const daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
      let ready: { port: number; token: string } | undefined;
      await until(() => {
        if (daemon.child.exitCode !== null) throw new Error(daemon.errors());
        try {
          ready = readRuntimeJson(join(f.home, 'test-daemon-ready.json')) as typeof ready;
          return true;
        } catch {
          return false;
        }
      }, 'Daemon did not start');
      const request = (path: string) =>
        fetch(`http://127.0.0.1:${ready!.port}${path}`, {
          headers: { authorization: `Bearer ${ready!.token}` },
          signal: AbortSignal.timeout(10_000),
        });
      const ports = async (sessionId: string) =>
        sessionPortsResponseSchema.parse(
          await (await request(`/api/sessions/${sessionId}/ports`)).json(),
        ).ports;
      const liveSession = f.runtimes.get(f.binding.runtime_id)!.active_session_id;
      const live = await viewer(ready!.port, ready!.token, liveSession);
      sockets.push(live.ws);
      expect(live.text()).toContain('initial-screen');
      if (pass < 2) {
        const detected = await ports(liveSession);
        expect(
          detected.some((port) => port.port === preview!.port && port.pid === preview!.pid),
        ).toBe(true);
        expect(detected.some((port) => port.port === hook.port)).toBe(false);
        expect(await (await request(`/proxy/${liveSession}/${preview!.port}/`)).text()).toBe(
          'surviving-preview',
        );
        const hidden = await request(`/proxy/${liveSession}/${hook.port}/`);
        expect(hidden.status).toBe(403);
        await hidden.arrayBuffer();
        live.input(`printf 'window-${pass}-%s\\n' "$survivor"; stty size\n`);
        await until(
          () => live.text().includes(`window-${pass}-kept`) && live.text().includes('25 90'),
          'Runtime input/resize was not routed',
        );
        expect(live.messages.filter((m) => m.t === 'error')).toEqual([]);
        expect(
          (
            readRuntimeJson(join(f.directory, 'state.json')) as {
              terminals: Array<{ pid: number }>;
            }
          ).terminals[0]?.pid,
        ).toBe(main.pid);
      } else {
        expect(await ports(liveSession)).toEqual([]);
        expect(live.text()).toContain('window-1-kept');
        expect(f.sessions.get(liveSession).status).toBe('exited');
        live.input('must-not-restart\n');
        await until(
          () => live.messages.some((message) => message.t === 'error'),
          'Ended runtime accepted input',
        );
      }
      if (pass === 0) {
        const closed = once(live.ws, 'close');
        // Select another saved conversation so the source remains historical.
        // Native clear/fork intentionally resume the source in another owner.
        await signal('second', 'resume');
        expect((await closed)[0]).toBe(1012);
        await until(
          () =>
            f.sessions.get(f.runtimes.get(f.binding.runtime_id)!.active_session_id)
              .agent_session_ref === 'second',
          'Native switch was not committed',
        );
        const second = await viewer(
          ready!.port,
          ready!.token,
          f.runtimes.get(f.binding.runtime_id)!.active_session_id,
        );
        expect(await ports(f.session.id)).toEqual([]);
        const historicalProxy = await request(`/proxy/${f.session.id}/${preview!.port}/`);
        expect(historicalProxy.status).toBe(403);
        await historicalProxy.arrayBuffer();
        expect(
          (await ports(f.runtimes.get(f.binding.runtime_id)!.active_session_id)).some(
            (port) => port.port === preview!.port && port.pid === preview!.pid,
          ),
        ).toBe(true);
        sockets.push(second.ws);
        second.input("printf 'new-%s\\n' segment\n");
        await until(
          () => second.text().includes('new-segment'),
          'New placement did not receive live output',
        );
        const historical = await viewer(ready!.port, ready!.token, f.session.id);
        sockets.push(historical.ws);
        expect(historical.text()).toContain('window-0-kept');
        expect(historical.text()).not.toContain('new-segment');
        historical.input('survivor=wrong\n');
        await until(
          () => historical.messages.some((m) => m.t === 'error'),
          'Historical input was not refused',
        );
      }
      for (const ws of sockets) ws.close();
      const stopped = once(daemon.child, 'exit');
      daemon.child.kill('SIGTERM');
      expect((await stopped)[0]).toBe(0);
      if (pass < 2) expect(runtime.child.exitCode).toBeNull();
      else expect(runtime.child.exitCode).not.toBeNull();
    }
  } finally {
    for (const ws of sockets) ws.terminate();
    await f.reconciler.close();
    f.db.close();
  }
});
