import { dirname, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { runtimeLaunchSchema } from '@puddle/shared';
import { RuntimeLauncher } from '../../../src/runtime/lifecycle/launcher.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { once } from 'node:events';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { retireMissingRuntime } from '../../../src/runtime/ownership/discovery.js';
import { removeRuntimeService } from '../../../src/runtime/lifecycle/supervisor.js';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { readRuntimeShellHooks } from '../../../src/runtime/execution/shell-hooks.js';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import {
  bundleDir,
  launchOwner,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';

function fixture(run: CompilationCommandRunner, installed = false) {
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
    installed
      ? { kind: 'launchd', installed: true, run }
      : {
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

it('pins the installed build before command construction can change the default', async () => {
  const run = vi.fn<CompilationCommandRunner>(async (command) => {
    const directory = dirname(command.args[2]!);
    const record = readRuntimeJson(join(directory, 'supervisor.json')) as {
      node_path: string;
      entry_path: string;
    };
    expect(record.node_path).toBe(join(first.release, 'bin', 'node'));
    expect(record.entry_path).toBe(join(first.release, 'daemon', 'puddler.mjs'));
    expect(f.runtimes.ownerOf(f.session.id)).toMatchObject({
      build: '1.2.3',
      protocol_major: 1,
      protocol_minor: 9,
      release_path: first.release,
    });
    void f.launcher.close(); // End an intentionally unconfirmed fake dispatch.
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const f = fixture(run, true);
  const first = runtimeRelease(f.home, '1.2.3', '1.9');
  const second = runtimeRelease(f.home, '2.3.4');
  first.select();
  try {
    await expect(
      f.launcher.launch(f.session.id, () => {
        second.select();
        return f.launch.main;
      }),
    ).rejects.toMatchObject({ code: 'runtime_launch_unconfirmed' });
    expect(run).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('refuses an incompatible installed default before preparing intent or dispatching', async () => {
  const run = vi.fn<CompilationCommandRunner>();
  const f = fixture(run, true);
  runtimeRelease(f.home, '2.3.4', '2.0').select();
  const command = vi.fn(() => f.launch.main);
  try {
    await expect(f.launcher.launch(f.session.id, command)).rejects.toThrow('incompatible');
    expect(command).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(f.runtimes.ownerOf(f.session.id)).toBeNull();
  } finally {
    await f.close();
  }
});

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

it('collects a confirmed provider startup failure without replaying its launch', async () => {
  const run = vi.fn<CompilationCommandRunner>(async (command) => {
    const directory = dirname(command.args[2]!);
    const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
    const owner = launchOwner(command.cwd, launch.identity.runtime_id);
    await once(owner.child, 'exit');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const f = fixture(run);
  try {
    const account = new AccountStore(f.db).create({
      profile_id: f.profile.id,
      agent_type: 'missing-provider',
      label: 'missing',
      config_dir: f.home,
      skip_permissions_default: false,
    });
    f.db
      .prepare(
        "UPDATE sessions SET kind = 'agent', agent_type = 'missing-provider', account_id = ? WHERE id = ?",
      )
      .run(account.id, f.session.id);
    f.sessions.setAgentSessionRef(f.session.id, f.session.id);
    await expect(
      f.launcher.launch(f.session.id, () => f.launch.main, {
        provider: {
          id: 'missing-provider',
          config_dir: f.home,
          mode: 'interactive',
          skip_permissions: false,
          initial_ref: f.session.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'runtime_launch_failed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.runtimes.selectedOwner(f.session.id)?.state).toBe('failed');
    expect(f.sessions.get(f.session.id).status).toBe('exited');
  } finally {
    await f.close();
  }
});
