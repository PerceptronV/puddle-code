import WebSocket from 'ws';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { WsServerMessage } from '@puddle/shared';
import { secret } from '@puddle/shared/node';
import { readRuntimeJson } from '../../src/runtime/storage.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import { launchOwner, waitForOwner } from '../helpers/runtime-fixture.js';

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('creates and stops extra shells, applies capture settings and archives a runtime through the real daemon', async () => {
  const f = runtimeDatabase();
  let ws: WebSocket | undefined;
  try {
    f.profiles.patchSettings(f.profile.id, { captureSessionEnv: true });
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    f.controller.release();
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
    const request = (path: string, method: string, body?: object) =>
      fetch(`http://127.0.0.1:${ready!.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    ws = new WebSocket(`ws://127.0.0.1:${ready!.port}/ws`);
    const messages: WsServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as WsServerMessage));
    await once(ws, 'open');
    const send = (message: object) =>
      ws!.send(JSON.stringify({ session: f.session.id, ...message }));
    send({ t: 'auth', token: ready!.token, resource: secret() });
    await until(() => messages.some((m) => m.t === 'authenticated'), 'No authentication');
    send({ t: 'spawn-shell' });
    send({ t: 'spawn-shell' });
    await until(
      () => messages.filter((m) => m.t === 'shell-spawned').length === 2,
      `Shells were not created: ${JSON.stringify(messages)}`,
    );
    expect(messages.filter((m) => m.t === 'shell-spawned').map((m) => m.term)).toEqual([
      'shell-1',
      'shell-2',
    ]);
    const attach = async (term: string) => {
      send({ t: 'attach', term, cols: 100, rows: 30 });
      await until(
        () => messages.some((m) => m.t === 'replay' && m.term === term),
        'No shell snapshot',
      );
    };
    const text = (term: string) =>
      messages
        .flatMap((m) => ((m.t === 'output' || m.t === 'replay') && m.term === term ? [m.data] : []))
        .join('');
    await attach('shell-1');
    send({ t: 'stdin', term: 'shell-1', data: 'stty -echo; printf \'seed-%s\\n\' "$INITIAL"\n' });
    await until(
      () => text('shell-1').includes('seed-seed'),
      'Captured environment did not reach the shell',
    );
    const settings = `/api/profiles/${f.profile.id}/settings`;
    expect((await request(settings, 'PATCH', { captureSessionEnv: false })).status).toBe(200);
    await until(
      () => f.reconciler.observations.get(f.binding.runtime_id)?.captureEnabled === false,
      'Capture policy did not reach owner',
    );
    expect(f.sessions.getEnv(f.session.id)).toMatchObject({ INITIAL: 'seed' });
    send({ t: 'spawn-shell' });
    await until(
      () => messages.some((m) => m.t === 'shell-spawned' && m.term === 'shell-3'),
      'Third shell was not created',
    );
    await attach('shell-3');
    send({
      t: 'stdin',
      term: 'shell-3',
      data: 'stty -echo; printf \'disabled-%s\\n\' "${INITIAL-unset}"\n',
    });
    await until(() => text('shell-3').includes('disabled-unset'), 'Disabled capture was injected');
    const capturedCount = Object.keys(f.sessions.getEnv(f.session.id)).length;
    const cleared = await request(`/api/sessions/${f.session.id}/env`, 'DELETE');
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: capturedCount });
    expect(f.sessions.getEnv(f.session.id)).toEqual({});
    expect((await request(settings, 'PATCH', { captureSessionEnv: true })).status).toBe(200);
    await until(
      () => f.reconciler.observations.get(f.binding.runtime_id)?.captureEnabled === true,
      'Capture was not enabled',
    );
    send({ t: 'kill-shell', term: 'shell-1' });
    await until(
      () => messages.some((m) => m.t === 'exit' && m.term === 'shell-1'),
      'Shell exit was not observed',
    );
    expect(owner.child.exitCode).toBeNull();
    // The main row may already be exited while extra shell tabs keep the owner alive.
    await attach('agent');
    send({ t: 'stdin', term: 'agent', data: 'exit 0\n' });
    await until(
      () =>
        f.sessions.get(f.session.id).status === 'exited' &&
        f.reconciler.observations
          .get(f.binding.runtime_id)
          ?.terminals.find((term) => term.term === 'agent')?.pid === null,
      'Main terminal did not exit while extra shells remained',
    );
    const archived = await request(`/api/sessions/${f.session.id}/archive`, 'POST');
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ status: 'archived' });
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('exited');
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(true);
    expect(
      f.reconciler.observations
        .get(f.binding.runtime_id)
        ?.terminals.every((term) => term.pid === null),
    ).toBe(true);
    expect(f.events.list(f.session.id).filter((event) => event.type === 'killed')).toHaveLength(1);
    expect(f.events.list(f.session.id).filter((event) => event.type === 'archived')).toHaveLength(
      1,
    );
    const stopped = once(daemon.child, 'exit');
    daemon.child.kill('SIGTERM');
    await stopped;
  } finally {
    ws?.terminate();
    await f.reconciler.close();
    f.db.close();
  }
});
