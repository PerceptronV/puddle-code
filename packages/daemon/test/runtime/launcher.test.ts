import { dirname, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { runtimeLaunchSchema } from '@puddle/shared';
import { RuntimeLauncher } from '../../src/runtime/launcher.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RuntimeConnections } from '../../src/runtime/connections.js';
import { retireMissingRuntime } from '../../src/runtime/discovery.js';
import { removeRuntimeService } from '../../src/runtime/supervisor.js';
import { readRuntimeJson, runtimeDirectory } from '../../src/runtime/storage.js';
import { readRuntimeShellHooks } from '../../src/runtime/shell-hooks.js';
import type { CompilationCommandRunner } from '../../src/compilation/process.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import {
  bundleDir,
  launchOwner,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../helpers/runtime-fixture.js';
import { placement } from '../helpers/runtime-placement.js';

function fixture(run: CompilationCommandRunner) {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
  f.controller.release();
  const connections = new RuntimeConnections(f.home, f.runtimes, {
    connected: (id, client) => f.reconciler.attach(id, client),
    missing: (id) => f.reconciler.retire(id),
  });
  const launcher = new RuntimeLauncher(
    {
      ...f,
      connections,
      projects: new ProjectStore(f.db),
      environment: {
        HOME: f.home,
        PATH: '/usr/bin:/bin',
        SURVIVING_BASE: 'original',
        CAPTURED: 'baseline',
      },
    },
    {
      kind: 'launchd',
      nodePath: process.execPath,
      entryPath: join(bundleDir, 'puddler.mjs'),
      releasePath: bundleDir,
      build: 'runtime-test',
      run,
    },
  );
  return {
    ...f,
    connections,
    launcher,
    async close() {
      await launcher.close();
      await f.reconciler.close();
      await connections.close();
      f.db.close();
    },
  };
}

it('persists launch intent before one supervisor dispatch and adopts after a lost dispatch reply', async () => {
  const run = vi.fn<CompilationCommandRunner>(async (command) => {
    const directory = dirname(command.args[2]!);
    const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
    expect(f.runtimes.get(launch.identity.runtime_id)?.state).toBe('prepared');
    expect(
      retireMissingRuntime(f.home, launch.identity, () => {
        throw new Error('Must not retire active launch');
      }),
    ).toBe('owned');
    expect(await removeRuntimeService(f.home, launch.identity, run)).toBe('owned');
    const owner = launchOwner(f.home, launch.identity.runtime_id);
    await waitForOwner(owner, directory);
    throw new Error('Supervisor acknowledgement lost');
  });
  const f = fixture(run);
  try {
    f.profiles.patchSettings(f.profile.id, { captureSessionEnv: true });
    f.sessions.mergeEnv(f.session.id, { CAPTURED: 'current' }, []);
    await f.launcher.launch(f.session.id, (hooks) => {
      const config = hooks.spawnConfig('/bin/bash', {
        captureEnv: true,
        historyFile: join(f.home, 'history'),
      });
      return {
        file: '/bin/bash',
        args: config.args,
        env: config.env,
        cwd: f.home,
        cols: 90,
        rows: 30,
      };
    });
    expect(run).toHaveBeenCalledTimes(1);
    const owner = f.runtimes.ownerOf(f.session.id)!;
    const client = f.connections.get(owner.runtime_id)!;
    const main = terminal(client.state);
    await client.request({
      t: 'input',
      placement: placement(client),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'stty -echo; printf "launch-%s-%s\\n" "$SURVIVING_BASE" "$CAPTURED"\n',
    });
    await waitForSnapshot(client, main.generation, 'launch-original-current');
    const directory = runtimeDirectory(f.home, owner.runtime_id);
    const hooks = readRuntimeShellHooks(directory)!;
    expect(hooks.spawnConfig('/bin/bash').args).toEqual([
      '--rcfile',
      join(directory, 'shell-hooks/bash/bashrc.bash'),
    ]);
    expect(readFileSync(join(directory, 'shell-hooks/bash/bashrc.bash'), 'utf8')).toContain(
      'PUDDLE_',
    );
    await expect(f.launcher.launch(f.session.id, () => f.launch.main)).rejects.toMatchObject({
      code: 'runtime_owned',
    });
    expect(run).toHaveBeenCalledTimes(1);
    await client.request({ t: 'stop', placement: placement(client) });
  } finally {
    await f.close();
  }
});

it('leaves an uncertain launch recorded on shutdown without dispatching it again', async () => {
  let release!: () => void;
  const run = vi.fn<CompilationCommandRunner>(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
      }),
  );
  const f = fixture(run);
  try {
    const pending = f.launcher.launch(f.session.id, () => f.launch.main);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_launch_unconfirmed' });
    await vi.waitFor(() => expect(release).toBeDefined());
    const closing = f.launcher.close();
    release();
    await closing;
    await rejected;
    expect(f.runtimes.ownerOf(f.session.id)?.state).toBe('prepared');
    const owner = f.runtimes.ownerOf(f.session.id)!;
    const directory = runtimeDirectory(f.home, owner.runtime_id);
    rmSync(join(directory, 'shell-hooks'), { recursive: true });
    expect(() => readRuntimeShellHooks(directory)).toThrow(
      'Pinned runtime shell hooks are missing',
    );
    expect(run).toHaveBeenCalledTimes(1);
    await f.connections.connect();
    expect(f.runtimes.ownerOf(f.session.id)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
