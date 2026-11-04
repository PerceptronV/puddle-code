import { acquireInstallationLock } from '../../../src/host/installation/lock.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { startSelectedDaemon } from '../../../src/host/startup/daemon.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../helpers/update-checkpoint.js';
import type {
  CompilationCommand,
  CompilationCommandRunner,
} from '../../../src/compilation/process.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture(kind: 'systemd' | 'launchd' = 'systemd') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-selected-start-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'bin/versions/0.4.0~ABC123');
  mkdirSync(join(root, 'bin'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'daemon'), { mode: 0o700 });
  for (const file of ['bin/node', 'daemon/host-update.mjs', 'daemon/install.sh'])
    writeFileSync(join(root, file), 'fixture', { mode: 0o700 });
  symlinkSync(root, join(home, 'bin/current'));
  writeFileSync(join(home, 'supervisor'), kind, { mode: 0o600 });
  const controller = { format: 1, id: randomUUID(), epoch: 5, active: true };
  atomicPrivateJson(join(home, 'runtime-controller.json'), controller);
  const definitionPath = join(home, 'service.plist');
  const plist = {
    Label: 'dev.puddle.puddled',
    ProgramArguments: [join(home, 'bin/current/puddled')],
    EnvironmentVariables: { PRESERVE: 'private fixture value' },
  };
  writeFileSync(definitionPath, JSON.stringify(plist), { mode: 0o600 });
  const state = {
    loaded: false,
    pid: null as number | null,
    bootoutLost: false,
    afterBootout: () => {},
    onList: () => {},
    failed: false,
    rateLimited: false,
    resetLost: false,
    afterReset: () => {},
    stopped: true,
    changed: false,
    lost: false,
    wrongExecutable: false,
    probe: () => {},
  };
  const commands: CompilationCommand[] = [];
  const run: CompilationCommandRunner = async (command) => {
    commands.push(command);
    const action = command.args[kind === 'systemd' ? 1 : 0];
    let stdout = '';
    if (command.file === '/usr/bin/plutil') stdout = JSON.stringify(plist);
    else if (action === 'managername') stdout = 'Aqua\n';
    else if (action === 'manageruid') stdout = `${process.getuid!()}\n`;
    else if (action === 'list') {
      state.onList();
      stdout = `${state.stopped ? (state.pid ?? '-') : process.pid}\t0\tdev.puddle.puddled\n`;
    } else if (action === 'cat') stdout = state.changed ? 'changed' : '[Service]\nExisting=yes';
    else if (command.args.includes('--property=ExecStart')) {
      const wrapper = state.wrongExecutable ? '/other/puddled' : join(home, 'bin/current/puddled');
      stdout = `{ path=${wrapper} ; argv[]=${wrapper} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
    } else if (action === 'show' && command.args.at(-1) === 'puddled.service') {
      state.probe();
      stdout = `Id=puddled.service\nLoadState=loaded\nActiveState=${state.stopped ? (state.failed ? 'failed' : 'inactive') : 'active'}\nSubState=${state.failed ? 'failed' : 'dead'}\nMainPID=${state.stopped ? 0 : process.pid}\nNeedDaemonReload=no\n`;
      if (command.args.some((arg) => arg.includes(',Result')))
        stdout += `Result=${state.rateLimited ? 'start-limit-hit' : state.failed ? 'exit-code' : 'success'}\n`;
    } else if (action === 'print' && state.stopped && !state.loaded)
      return { exitCode: 113, stdout, stderr: '' };
    else if (action === 'bootout') {
      expect(() => acquireHostClaim(home, 'daemon-controller')).toThrow('owns this host claim');
      state.loaded = false;
      state.afterBootout();
      if (state.bootoutLost) throw new Error('Bootout reply lost');
    } else if (action === 'reset-failed') {
      state.failed = false;
      state.rateLimited = false;
      state.afterReset();
      if (state.resetLost) throw new Error('Reset reply lost');
    } else if (action === 'start' || action === 'bootstrap') {
      // Startup can acquire the released controller, while update/installer exclusion remains.
      const controller = acquireHostClaim(home, 'daemon-controller');
      controller.release();
      expect(() => acquireHostClaim(home, 'host-update-execution')).toThrow();
      expect(() => acquireInstallationLock(home)).toThrow('Another installer');
      state.stopped = false;
      if (state.lost) throw new Error('Supervisor reply lost');
    }
    return { exitCode: 0, stdout, stderr: '' };
  };
  const options = {
    run,
    platform: kind === 'systemd' ? ('linux' as const) : ('darwin' as const),
    uid: process.getuid!(),
    definitionPath,
  };
  const start = () => startSelectedDaemon(home, root, options);
  const mutations = () =>
    commands.filter(({ args }) =>
      ['start', 'bootstrap'].includes(args[kind === 'systemd' ? 1 : 0]!),
    );
  return { home, root, controller, definitionPath, commands, state, start, mutations };
}

it.each(['systemd', 'launchd'] as const)(
  'starts the selected %s service once without changing selectors, configuration or controller identity',
  async (kind) => {
    const f = fixture(kind);
    const before = readFileSync(f.definitionPath);
    await f.start();
    expect(f.mutations()).toHaveLength(1);
    expect(readFileSync(f.definitionPath)).toEqual(before);
    expect(JSON.parse(readFileSync(join(f.home, 'runtime-controller.json'), 'utf8'))).toEqual(
      f.controller,
    );
    acquireInstallationLock(f.home).release();
    expect(
      f.commands.some(
        ({ args }) =>
          args.includes('stop') ||
          args.includes('restart') ||
          args.includes('kickstart') ||
          args.includes('bootout'),
      ),
    ).toBe(false);
  },
);

it.each([
  'live-controller',
  'update-execution',
  'installer',
  'unfinished-update',
  'running-service',
  'changed-definition',
  'wrong-executable',
  'lost-reply',
])('preserves existing work when startup encounters %s', async (failure) => {
  const f = fixture();
  if (failure === 'live-controller' || failure === 'update-execution') {
    const claim = acquireHostClaim(
      f.home,
      failure === 'live-controller' ? 'daemon-controller' : 'host-update-execution',
    );
    cleanup.push(() => claim.release());
  } else if (failure === 'installer') mkdirSync(join(f.home, 'bin/.install-lock'));
  else if (failure === 'unfinished-update') acceptedCheckpointUpdate(f.home);
  else if (failure === 'running-service') f.state.stopped = false;
  else if (failure === 'changed-definition')
    f.state.probe = () => {
      f.state.changed = true;
    };
  else if (failure === 'wrong-executable') f.state.wrongExecutable = true;
  else f.state.lost = true;
  await expect(f.start()).rejects.toThrow();
  expect(f.mutations()).toHaveLength(failure === 'lost-reply' ? 1 : 0);
  if (failure === 'installer') expect(existsSync(join(f.home, 'bin/.install-lock'))).toBe(true);
  else acquireInstallationLock(f.home).release();
});

it('unloads an idle launchd registration before bootstrapping its validated plist', async () => {
  const f = fixture('launchd');
  f.state.loaded = true;
  await f.start();
  expect(
    f.commands
      .filter(({ args }) => ['bootout', 'bootstrap'].includes(args[0]!))
      .map(({ args }) => args),
  ).toEqual([
    ['bootout', `gui/${process.getuid!()}/dev.puddle.puddled`],
    ['bootstrap', `gui/${process.getuid!()}`, f.definitionPath],
  ]);
  expect(f.commands.some(({ args }) => args.includes('kickstart'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.home, 'runtime-controller.json'), 'utf8'))).toEqual(
    f.controller,
  );
});

it.each(['lost-reply', 'configuration', 'live-process'] as const)(
  'does not bootstrap an idle launchd job after %s uncertainty',
  async (failure) => {
    const f = fixture('launchd');
    f.state.loaded = true;
    f.state.bootoutLost = failure === 'lost-reply';
    if (failure === 'configuration')
      f.state.afterBootout = () => {
        writeFileSync(f.definitionPath, 'changed definition');
      };
    if (failure === 'live-process') {
      let lists = 0;
      f.state.onList = () => {
        if (++lists === 3) f.state.pid = process.pid;
      };
    }
    await expect(f.start()).rejects.toThrow();
    expect(f.mutations()).toEqual([]);
    acquireInstallationLock(f.home).release();
    expect(f.commands.filter(({ args }) => args[0] === 'bootout')).toHaveLength(
      failure === 'live-process' ? 0 : 1,
    );
    if (failure === 'lost-reply') {
      // A new explicit request observes the unloaded registration, without another bootout.
      f.state.bootoutLost = false;
      await f.start();
      expect(f.mutations()).toHaveLength(1);
      expect(f.commands.filter(({ args }) => args[0] === 'bootout')).toHaveLength(1);
    }
  },
);

it('starts a non-rate-limited failed service without resetting its failure evidence', async () => {
  const f = fixture();
  f.state.failed = true;
  await f.start();
  expect(f.mutations()).toHaveLength(1);
  expect(f.commands.some(({ args }) => args.includes('reset-failed'))).toBe(false);
});

it.each([true, false])(
  'resets only the selected start-limited unit before one start (failed=%s)',
  async (failed) => {
    const f = fixture();
    f.state.failed = failed;
    f.state.rateLimited = true;
    await f.start();
    expect(
      f.commands
        .filter(({ args }) => ['reset-failed', 'start'].includes(args[1]!))
        .map(({ args }) => args),
    ).toEqual([
      ['--user', 'reset-failed', 'puddled.service'],
      ['--user', 'start', 'puddled.service'],
    ]);
    expect(JSON.parse(readFileSync(join(f.home, 'runtime-controller.json'), 'utf8'))).toEqual(
      f.controller,
    );
  },
);

it.each(['lost-reply', 'definition', 'process'] as const)(
  'does not start after a reset with %s uncertainty',
  async (failure) => {
    const f = fixture();
    f.state.failed = true;
    f.state.rateLimited = true;
    f.state.resetLost = failure === 'lost-reply';
    f.state.afterReset = () => {
      if (failure === 'definition') f.state.changed = true;
      if (failure === 'process') f.state.stopped = false;
    };
    await expect(f.start()).rejects.toThrow();
    expect(f.commands.filter(({ args }) => args[1] === 'reset-failed')).toHaveLength(1);
    expect(f.mutations()).toHaveLength(0);
    acquireInstallationLock(f.home).release();
  },
);

it('retains an undispatched preparation while starting the selected daemon for fresh review', async () => {
  const f = fixture();
  const store = new HostUpdateOperations(f.home);
  const pending = store.begin([{ component: 'daemon', version: '0.4.1' }]).operation;
  await f.start();
  expect(store.read()).toEqual(pending);
  expect(f.mutations()).toHaveLength(1);
});

it('requires ended-worker evidence even when a previous update reports completion', async () => {
  const f = fixture();
  const accepted = acceptedCheckpointUpdate(f.home);
  checkpointWorker(f.home, accepted, {
    pid: process.pid,
    controller: { id: f.controller.id, epoch: 5 },
  });
  const worker = accepted.store.claimExecution(
    accepted.operation,
    accepted.operation.dispatch_id!,
    accepted.operation.preflight!,
  );
  worker.verifying();
  worker.complete(digest('verified update'));
  worker.release();
  await expect(f.start()).rejects.toThrow();
  expect(f.mutations()).toEqual([]);
});
