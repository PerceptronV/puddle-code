import { once } from 'node:events';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runtimeLaunchSchema, runtimeStateSchema, sessionSchema } from '@puddle/shared';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { readRuntimeJson, runtimeDirectory } from '../../src/runtime/storage.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import { launchOwner } from '../helpers/runtime-fixture.js';
import { sh } from '../helpers/git-fixtures.js';
import { waitFor } from '../helpers/daemon-fixtures.js';

it('launches interactive providers, adopts offline native switches and resumes the exact conversation', async () => {
  const f = runtimeDatabase('interactive');
  let daemon: ReturnType<typeof launchOwner> | undefined;
  let ready: { port: number; token: string } | undefined;
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
    const ended = once(daemon!.child, 'exit');
    daemon!.child.kill('SIGTERM');
    expect((await ended)[0]).toBe(0);
  };
  const create = async (accountId: number) => {
    const response = await request('/api/sessions', {
      project_id: f.project.id,
      account_id: accountId,
      separate_branch: false,
      separate_worktree: false,
      prompt: 'Keep this launch exactly once',
    });
    expect(response.status).toBe(201);
    return sessionSchema.parse(await response.json());
  };
  try {
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    sh(f.home, 'init', '-b', 'main');
    writeFileSync(join(f.home, 'test-enable-runtime-launcher'), '');
    f.controller.release();
    await start();
    const session = await create(f.account!.id);
    const owner = f.runtimes.ownerOf(session.id)!;
    runtimeIds.add(owner.runtime_id);
    expect(session.native_sync).toBe('full');
    expect(session.agent_session_ref).toBeNull(); // No catalogue guess before the exact hook.
    const directory = runtimeDirectory(f.home, owner.runtime_id);
    const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
    expect(launch.provider?.prompt).toContain('Keep this launch exactly once');
    const initial = runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
    const hook = readRuntimeJson(join(f.home, `${session.id}.signals.json`)) as {
      url: string;
      nonce: string;
      port: number;
      pid: number;
    };
    const sidecar = async () =>
      (await (await fetch(`http://127.0.0.1:${hook.port}`)).json()) as {
        pid: number;
        counter: number;
      };
    const signal = async (ref: string, source: string) => {
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
      expect(response.status).toBe(204);
      await response.arrayBuffer();
    };
    await signal('launch-first', 'startup');
    await waitFor(() => f.sessions.get(session.id).agent_session_ref === 'launch-first');
    const before = await sidecar();
    const duplicate = await request(`/api/sessions/${session.id}/resume`);
    expect(duplicate.status).toBe(409);
    await duplicate.arrayBuffer();
    await stop();
    await signal('launch-second', 'clear');
    const during = await sidecar();
    expect(during).toEqual({ pid: before.pid, counter: before.counter + 1 });
    await start();
    const active = f.runtimes.get(owner.runtime_id)!.active_session_id;
    expect(active).not.toBe(session.id);
    expect(f.sessions.get(active).agent_session_ref).toBe('launch-second');
    expect(f.reconciler.observations.get(owner.runtime_id)?.terminals[0]?.pid).toBe(
      initial.terminals[0]!.pid,
    );
    expect((await sidecar()).pid).toBe(before.pid);
    expect(runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')))).toEqual(
      launch,
    );
    const killed = await request(`/api/sessions/${active}/kill`);
    expect(killed.status).toBe(200);
    await killed.arrayBuffer();
    const resumed = await request(`/api/sessions/${active}/resume`);
    expect(resumed.status).toBe(200);
    await resumed.arrayBuffer();
    const replacement = f.runtimes.ownerOf(active)!;
    runtimeIds.add(replacement.runtime_id);
    expect(replacement.runtime_id).not.toBe(owner.runtime_id);
    expect(
      runtimeLaunchSchema.parse(
        readRuntimeJson(join(runtimeDirectory(f.home, replacement.runtime_id), 'launch.json')),
      ).provider?.resume_ref,
    ).toBe('launch-second');
    const archived = await request(`/api/sessions/${active}/archive`);
    expect(archived.status).toBe(200);
    await archived.arrayBuffer();

    const preset = new AccountStore(f.db).create({
      profile_id: f.profile.id,
      agent_type: 'runtime-preset-test',
      label: 'preset',
      config_dir: f.home,
      skip_permissions_default: false,
    });
    const fallback = await create(preset.id);
    const fallbackOwner = f.runtimes.ownerOf(fallback.id)!;
    runtimeIds.add(fallbackOwner.runtime_id);
    expect(fallback).toMatchObject({ native_sync: 'fallback', agent_session_ref: fallback.id });
    const seeded = runtimeLaunchSchema.parse(
      readRuntimeJson(join(runtimeDirectory(f.home, fallbackOwner.runtime_id), 'launch.json')),
    );
    expect(seeded.provider).toMatchObject({ initial_ref: fallback.id });
    expect(seeded.provider?.resume_ref).toBeUndefined();
    const ended = await request(`/api/sessions/${fallback.id}/archive`);
    expect(ended.status).toBe(200);
    await ended.arrayBuffer();
    await stop();
  } finally {
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
        /* Only isolated fake-supervisor children; already stopped or never dispatched. */
      }
    }
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) await stop();
    await f.reconciler.close();
    f.db.close();
  }
});
