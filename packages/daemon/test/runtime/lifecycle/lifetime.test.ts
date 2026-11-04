import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import { runtimeStateSchema } from '@puddle/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { selectRuntimeSupervisor } from '../../../src/runtime/lifecycle/lifetime.js';
import { requireIndependentProcessGroup } from '../../../src/runtime/lifecycle/process.js';
import {
  startRuntimeService,
  removeRuntimeService,
} from '../../../src/runtime/lifecycle/supervisor.js';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import {
  acquireRuntimeController,
  readRuntimeJson,
} from '../../../src/runtime/ownership/storage.js';
import {
  bundleDir,
  admitFixtureOwner,
  children,
  clients,
  controllers,
  environment,
  launchOwner,
  prepare,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.each(['nohup', 'none'])(
  'uses a limited host-session owner only for an explicit %s installation',
  async (marker) => {
    const f = prepare();
    writeFileSync(join(f.home, 'supervisor'), marker, { mode: 0o600 });
    const unavailable = vi.fn(async () => {
      throw new Error('No manager');
    });
    expect(await selectRuntimeSupervisor(f.home, unavailable)).toBe('detached');
    expect(unavailable).toHaveBeenCalledOnce();
    const available = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    expect(await selectRuntimeSupervisor(f.home, available)).toBe(
      process.platform === 'darwin' ? 'launchd' : 'systemd',
    );
  },
);

it.each(['systemd', 'launchd', 'unexpected', null])(
  'refuses an unavailable manager for marker %s without choosing another lifetime',
  async (marker) => {
    const f = prepare();
    if (marker !== null) writeFileSync(join(f.home, 'supervisor'), marker, { mode: 0o600 });
    await expect(
      selectRuntimeSupervisor(f.home, async () => {
        throw new Error('No manager');
      }),
    ).rejects.toThrow();
  },
);

it('refuses a group shared with the launcher and bounds process inspection', async () => {
  const f = prepare();
  const run = vi.fn(async () => ({ exitCode: 0, stdout: String(process.pid + 1), stderr: '' }));
  await expect(requireIndependentProcessGroup(f.home, run)).rejects.toThrow('own process group');
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ timeoutMs: 3000, maxOutputBytes: 128 }),
  );
});

it('refuses a launch from another boot before consuming intent or starting its shell', async () => {
  const f = prepare();
  const boot = await readHostBootIdentity();
  expect(boot).not.toBeNull();
  const other = randomUUID();
  expect(other).not.toBe(boot);
  atomicPrivateJson(join(f.directory, 'launch.json'), { ...f.launch, boot_id: other });
  const owner = launchOwner(f.home, f.launch.identity.runtime_id);
  await once(owner.child, 'exit');
  expect(owner.errors()).toContain('another or unverified host boot');
  expect(existsSync(join(f.directory, 'consumed.json'))).toBe(false);
  expect(existsSync(join(f.directory, 'state.json'))).toBe(false);
});

it('keeps a detached shell and its state through controller replacement, then retires without service commands', async () => {
  const f = prepare();
  const boot = await readHostBootIdentity();
  expect(boot).not.toBeNull();
  const launch = { ...f.launch, boot_id: boot!, lifetime: 'host_session' as const };
  atomicPrivateJson(join(f.directory, 'launch.json'), launch);
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  let owner: { child: ChildProcess; errors: () => string } | undefined;
  vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof spawn>) => {
    const child = actual.spawn(...args);
    children.push(child);
    owner = { child, errors: () => 'Detached runtime did not publish state' };
    return child;
  });
  const run = vi.fn(async () => {
    throw new Error('No service manager command expected');
  });
  const options = {
    kind: 'detached' as const,
    nodePath: process.execPath,
    entryPath: join(bundleDir, 'puddler.mjs'),
    environment: environment(f.home),
    run,
  };
  admitFixtureOwner(f.home, launch.identity.runtime_id);
  const record = await startRuntimeService(f.home, launch.identity, options);
  await waitForOwner(owner!, f.directory);
  expect(record.state).toBe('dispatched');
  expect(await startRuntimeService(f.home, launch.identity, options)).toEqual(record);
  expect(run).not.toHaveBeenCalled();
  const first = await RuntimeClient.open(f.home, launch, f.controller.record);
  clients.push(first);
  const main = terminal(first.state);
  await first.request({
    t: 'input',
    placement: { session_id: launch.identity.session_id, segment_id: launch.identity.runtime_id },
    term: 'agent',
    generation: main.generation,
    source: 'human',
    data: 'stty -echo; kept=detached; cd /; printf "before-%s\\n" "$kept"\n',
  });
  await waitForSnapshot(first, main.generation, 'before-detached');
  expect(await removeRuntimeService(f.home, launch.identity, run)).toBe('owned');
  first.close();
  f.controller.release();
  const replacement = acquireRuntimeController(f.home);
  controllers.push(replacement);
  const next = await RuntimeClient.open(f.home, launch, replacement.record);
  clients.push(next);
  expect(next.state?.lifetime).toBe('host_session');
  expect(terminal(next.state)).toMatchObject({ pid: main.pid, generation: main.generation });
  owner!.child.kill('SIGHUP');
  await next.request({
    t: 'input',
    placement: { session_id: launch.identity.session_id, segment_id: launch.identity.runtime_id },
    term: 'agent',
    generation: main.generation,
    source: 'human',
    data: 'printf "after-%s-%s\\n" "$kept" "$PWD"\n',
  });
  await waitForSnapshot(next, main.generation, 'after-detached-/');
  const exited = once(owner!.child, 'exit');
  await next.request({
    t: 'stop',
    placement: { session_id: launch.identity.session_id, segment_id: launch.identity.runtime_id },
  });
  await exited;
  expect(await removeRuntimeService(f.home, launch.identity, run)).toBe('removed');
  expect(run).not.toHaveBeenCalled();
  expect(runtimeStateSchema.parse(readRuntimeJson(join(f.directory, 'state.json'))).state).toBe(
    'exited',
  );
  await expect(startRuntimeService(f.home, launch.identity, options)).rejects.toThrow('retired');
});
