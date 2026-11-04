import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { sessionSchema, type WsServerMessage } from '@puddle/shared';
import { secret } from '@puddle/shared/node';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { launchOwner } from '../../helpers/runtime-fixture.js';
import { sh } from '../../helpers/git-fixtures.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';

it('creates and resumes terminal owners through the real daemon while ordinary restart preserves execution', async () => {
  const f = runtimeDatabase();
  let daemon: ReturnType<typeof launchOwner> | undefined;
  let ready: { port: number; token: string } | undefined;
  let ws: WebSocket | undefined;
  const runtimeIds = new Set<string>();
  const request = (path: string, body?: object) =>
    fetch(`http://127.0.0.1:${ready!.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20_000),
    });
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
    ws?.terminate();
    const ended = once(daemon!.child, 'exit');
    daemon!.child.kill('SIGTERM');
    expect((await ended)[0]).toBe(0);
  };
  const attach = async (session: string) => {
    ws = new WebSocket(`ws://127.0.0.1:${ready!.port}/ws`);
    const messages: WsServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as WsServerMessage));
    await once(ws, 'open');
    const send = (message: object) => ws!.send(JSON.stringify({ session, ...message }));
    send({ t: 'auth', token: ready!.token, resource: secret() });
    await waitFor(() => messages.some((m) => m.t === 'authenticated'));
    send({ t: 'attach', term: 'agent', cols: 90, rows: 30 });
    await waitFor(() => messages.some((m) => m.t === 'replay'));
    return {
      send,
      text: () =>
        messages.flatMap((m) => (m.t === 'output' || m.t === 'replay' ? [m.data] : [])).join(''),
    };
  };
  try {
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    sh(f.home, 'init', '-b', 'main');
    mkdirSync(join(f.home, 'source'));
    writeFileSync(join(f.home, 'test-enable-runtime-launcher'), '');
    f.controller.release();
    await start();
    const created = await request('/api/sessions', {
      project_id: f.project.id,
      kind: 'terminal',
      cwd: 'source',
    });
    expect(created.status).toBe(201);
    const session = sessionSchema.parse(await created.json());
    const owner = f.runtimes.ownerOf(session.id)!;
    runtimeIds.add(owner.runtime_id);
    expect(owner.state).toBe('running');
    const state = () =>
      readRuntimeJson(join(runtimeDirectory(f.home, owner.runtime_id), 'state.json')) as {
        terminals: Array<{ pid: number }>;
        theme: { fg: string; bg: string } | null;
      };
    const pid = state().terminals[0]!.pid;
    const hookPath = join(
      runtimeDirectory(f.home, owner.runtime_id),
      'shell-hooks/bash/bashrc.bash',
    );
    const hook = readFileSync(hookPath, 'utf8');
    const first = await attach(session.id);
    const colours = { fg: '#123456', bg: '#abcdef' };
    first.send({ t: 'theme', ...colours });
    await waitFor(() => state().theme?.bg === colours.bg);
    first.send({
      t: 'stdin',
      term: 'agent',
      data: 'stty -echo; survivor=kept; printf "first-%s\\n" "$survivor"; pwd\n',
    });
    await waitFor(() => first.text().includes('first-kept') && first.text().includes('/source'));
    await stop();
    expect(state().terminals[0]!.pid).toBe(pid);
    await start();
    const second = await attach(session.id);
    expect(state().theme).toEqual(colours); // No new report must not clear the owner's colours.
    const replacementColours = { fg: '#fedcba', bg: '#654321' };
    second.send({ t: 'theme', ...replacementColours });
    await waitFor(() => state().theme?.bg === replacementColours.bg);
    second.send({ t: 'stdin', term: 'agent', data: 'printf "second-%s\\n" "$survivor"\n' });
    await waitFor(() => second.text().includes('second-kept'));
    expect(state().terminals[0]!.pid).toBe(pid);
    expect(readFileSync(hookPath, 'utf8')).toBe(hook);
    const killed = await request(`/api/sessions/${session.id}/kill`);
    expect(killed.status).toBe(200);
    await killed.arrayBuffer();
    expect(f.runtimes.get(owner.runtime_id)?.state).toBe('exited');
    const resumed = await request(`/api/sessions/${session.id}/resume`);
    expect(resumed.status).toBe(200);
    await resumed.arrayBuffer();
    const replacement = f.runtimes.ownerOf(session.id)!;
    runtimeIds.add(replacement.runtime_id);
    expect(
      readRuntimeJson(join(runtimeDirectory(f.home, replacement.runtime_id), 'launch.json')),
    ).toMatchObject({ theme: replacementColours });
    expect(replacement.runtime_id).not.toBe(owner.runtime_id);
    const third = await attach(session.id);
    third.send({
      t: 'stdin',
      term: 'agent',
      data: 'stty -echo; printf "resumed-%s\\n" "${survivor-unset}"\n',
    });
    await waitFor(() => third.text().includes('resumed-unset'));
    const archived = await request(`/api/sessions/${session.id}/archive`);
    expect(archived.status).toBe(200);
    await archived.arrayBuffer();
    expect(f.runtimes.get(replacement.runtime_id)?.state).toBe('exited');
    await stop();
  } finally {
    ws?.terminate();
    // Only PIDs recorded by this isolated fake supervisor, never host services.
    for (const id of new Set([
      ...runtimeIds,
      ...f.runtimes.live().map((runtime) => runtime.runtime_id),
    ])) {
      try {
        const { pid } = readRuntimeJson(
          join(runtimeDirectory(f.home, id), 'test-supervisor-pid.json'),
        ) as { pid: number };
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Already stopped, or no dispatch occurred. */
      }
    }
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) await stop();
    await f.reconciler.close();
    f.db.close();
  }
});
