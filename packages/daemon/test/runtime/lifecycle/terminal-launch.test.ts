import { once } from 'node:events';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import {
  sessionSchema,
  sessionRuntimeInspectionSchema,
  type WsServerMessage,
} from '@puddle/shared';
import { secret } from '@puddle/shared/node';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { bundleDir, launchOwner } from '../../helpers/runtime-fixture.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { sh } from '../../helpers/git-fixtures.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';

it('creates and resumes terminal owners through the real daemon while ordinary restart preserves execution', async () => {
  const f = runtimeDatabase();
  let daemon: ReturnType<typeof launchOwner> | undefined;
  let ready: { port: number; token: string } | undefined;
  let ws: WebSocket | undefined;
  const runtimeIds = new Set<string>();
  const installRuntime = (version: string) => {
    const release = runtimeRelease(f.home, version);
    copyFileSync(process.execPath, join(release.release, 'bin', 'node'));
    copyFileSync(
      join(bundleDir, 'provider-owner.mjs'),
      join(release.release, 'daemon', 'puddler.mjs'),
    );
    cpSync(join(bundleDir, 'node_modules'), join(release.release, 'node_modules'), {
      recursive: true,
    });
    release.select();
  };
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
    writeFileSync(join(f.home, 'test-installed-runtime-launcher'), '');
    installRuntime('0.4.0');
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
    const inspect = async () => {
      const response = await fetch(
        `http://127.0.0.1:${ready!.port}/api/sessions/${session.id}/runtime`,
        {
          headers: { authorization: `Bearer ${ready!.token}` },
        },
      );
      expect(response.status).toBe(200);
      return sessionRuntimeInspectionSchema.parse(await response.json());
    };
    const beforeShell = await inspect();
    expect(beforeShell.restart.available).toBe(true);
    third.send({ t: 'spawn-shell' });
    await waitFor(() => f.runtimes.terminalForPlacement(session.id, 'shell-1') !== null);
    const stale = await request(`/api/sessions/${session.id}/runtime/restart`, {
      fingerprint: beforeShell.restart.available ? beforeShell.restart.fingerprint : '',
    });
    expect(stale.status).toBe(409);
    await stale.arrayBuffer();
    expect(f.runtimes.get(replacement.runtime_id)?.state).toBe('running');
    const neighbour = sessionSchema.parse(
      await (
        await request('/api/sessions', {
          project_id: f.project.id,
          kind: 'terminal',
          separate_branch: false,
          separate_worktree: false,
        })
      ).json(),
    );
    const neighbourOwner = f.runtimes.ownerOf(neighbour.id)!;
    runtimeIds.add(neighbourOwner.runtime_id);
    const neighbourPid = () =>
      (
        readRuntimeJson(
          join(runtimeDirectory(f.home, neighbourOwner.runtime_id), 'state.json'),
        ) as { terminals: Array<{ pid: number }> }
      ).terminals[0]!.pid;
    const survivingPid = neighbourPid();
    installRuntime('0.4.1');
    expect(f.runtimes.ownerOf(session.id)?.build).toBe('0.4.0');
    const reviewed = await inspect();
    expect(reviewed.installed?.version).toBe('0.4.1');
    expect(reviewed.runtime?.version).toBe('0.4.0');
    expect(reviewed.runtime?.terminals?.map(({ term }) => term)).toEqual(['agent', 'shell-1']);
    const fingerprint = reviewed.restart.available ? reviewed.restart.fingerprint : '';
    const restarted = await request(`/api/sessions/${session.id}/runtime/restart`, { fingerprint });
    expect(restarted.status, await restarted.text()).toBe(200);
    const selected = f.runtimes.ownerOf(session.id)!;
    runtimeIds.add(selected.runtime_id);
    expect(selected.build).toBe('0.4.1');
    expect(selected.runtime_id).not.toBe(replacement.runtime_id);
    expect(f.runtimes.get(replacement.runtime_id)?.state).toBe('exited');
    expect(f.runtimes.ownerOf(neighbour.id)?.runtime_id).toBe(neighbourOwner.runtime_id);
    expect(f.runtimes.get(neighbourOwner.runtime_id)?.state).toBe('running');
    expect(neighbourPid()).toBe(survivingPid);
    process.kill(survivingPid, 0);
    expect(f.runtimes.terminalForPlacement(session.id, 'shell-1')).toBeNull();
    const replay = await request(`/api/sessions/${session.id}/runtime/restart`, { fingerprint });
    expect(replay.status).toBe(409);
    await replay.arrayBuffer();
    expect(f.runtimes.ownerOf(session.id)?.runtime_id).toBe(selected.runtime_id);
    const neighbourStopped = await request(`/api/sessions/${neighbour.id}/kill`);
    expect(neighbourStopped.status).toBe(200);
    await neighbourStopped.arrayBuffer();
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
