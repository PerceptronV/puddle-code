import { chmodSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HostUpdateSupervision } from '../../../src/updates/preflight/supervision.js';
import type { CompilationCommand } from '../../../src/compilation/process.js';
import { systemdObservation, launchdObservation } from '../../helpers/host-supervision.js';
import { candidateFixture } from './helpers.js';

function setup(platform: 'linux' | 'darwin' = 'linux', component: 'daemon' | 'runtime' = 'daemon') {
  const f = candidateFixture(component);
  const definitionPath = join(f.home, 'daemon.plist');
  const plist = {
    Label: 'dev.puddle.puddled',
    ProgramArguments: [join(f.home, 'bin/current/puddled')],
  };
  writeFileSync(definitionPath, JSON.stringify(plist), { mode: 0o600 });
  const run = vi.fn(async (command: CompilationCommand) => ({
    exitCode: 0,
    stderr: '',
    stdout:
      platform === 'linux'
        ? systemdObservation(123)
        : command.file === '/usr/bin/plutil'
          ? JSON.stringify(plist)
          : command.args[0] === 'managername'
            ? 'Aqua'
            : command.args[0] === 'manageruid'
              ? String(process.getuid!())
              : command.args[0] === 'list'
                ? launchdObservation(123)
                : '',
  }));
  const inspector = new HostUpdateSupervision({
    home: f.home,
    pid: 123,
    platform,
    run,
    definitionPath,
  });
  return { ...f, run, inspector };
}

it.each(['linux', 'darwin'] as const)(
  'corroborates the %s marker with a live supervisor process',
  async (platform) => {
    const f = setup(platform);
    writeFileSync(join(f.home, 'supervisor'), platform === 'linux' ? 'systemd\n' : 'launchd\n', {
      mode: 0o644,
    });
    const result = await f.inspector.inspect(f.operation);
    expect(result.blockers).toEqual([]);
    expect(result.daemon?.pid).toBe(123);
    expect(result.worker?.kind).toBe(platform === 'linux' ? 'systemd' : 'launchd');
    expect(f.store.read()?.phase).toBe('staged');
  },
);

it.each(['missing', 'nohup', 'none', 'large', 'symlink', 'other-platform'] as const)(
  'refuses a %s marker without starting or stopping services',
  async (failure) => {
    const f = setup();
    const marker = join(f.home, 'supervisor');
    if (failure === 'symlink') {
      writeFileSync(join(f.home, 'other'), 'systemd');
      symlinkSync(join(f.home, 'other'), marker);
    } else if (failure !== 'missing') {
      writeFileSync(
        marker,
        failure === 'large' ? 'x'.repeat(4096) : failure === 'other-platform' ? 'launchd' : failure,
      );
    }
    expect((await f.inspector.inspect(f.operation)).blockers).toEqual([
      { code: 'daemon_supervision_unknown', target: 'daemon' },
    ]);
    expect(f.run).toHaveBeenCalledOnce(); // Read-only manager probe, no service mutation.
  },
);

it.each([0o664, 0o646, 0o666])(
  'identifies unsafe marker permissions (%s) without repairing during inspection',
  async (mode) => {
    const f = setup();
    const marker = join(f.home, 'supervisor');
    writeFileSync(marker, 'systemd\n');
    chmodSync(marker, mode);
    expect((await f.inspector.inspect(f.operation)).blockers).toEqual([
      { code: 'daemon_supervisor_marker_permissions', target: 'daemon' },
    ]);
    expect(statSync(marker).mode & 0o777).toBe(mode);
    expect(f.run).toHaveBeenCalledOnce();

    // Explicit host-side repair permits a fresh inspection, not automatic approval.
    chmodSync(marker, mode & ~0o022);
    expect((await f.inspector.inspect(f.operation)).blockers).toEqual([]);
    f.run.mockImplementation(async () => ({
      exitCode: 0,
      stdout: systemdObservation(456),
      stderr: '',
    }));
    expect((await f.inspector.inspect(f.operation)).blockers).toEqual([
      { code: 'daemon_supervision_unknown', target: 'daemon' },
    ]);
  },
);

it('allows a runtime default change with an available independent manager and a manual daemon', async () => {
  const f = setup('linux', 'runtime');
  expect(await f.inspector.inspect(f.operation)).toEqual({
    worker: { kind: 'systemd', domain: null },
    daemon: null,
    blockers: [],
  });
  expect(f.run).toHaveBeenCalledOnce();
});

it.each(['linux', 'darwin'] as const)(
  'repairs a corroborated legacy %s marker during preparation',
  async (platform) => {
    const f = setup(platform);
    const marker = join(f.home, 'supervisor');
    writeFileSync(marker, platform === 'linux' ? 'systemd\n' : 'launchd\n');
    chmodSync(marker, 0o664);
    await f.inspector.prepare(f.operation, () => {});
    expect(statSync(marker).mode & 0o777).toBe(0o644);
    expect((await f.inspector.inspect(f.operation)).blockers).toEqual([]);
  },
);

it.each(['mismatched-service', 'revoked', 'runtime-only'] as const)(
  'does not repair with %s',
  async (failure) => {
    const f = setup('linux', failure === 'runtime-only' ? 'runtime' : 'daemon');
    const marker = join(f.home, 'supervisor');
    writeFileSync(marker, 'systemd\n');
    chmodSync(marker, 0o664);
    if (failure === 'mismatched-service')
      f.run.mockImplementation(async () => ({
        exitCode: 0,
        stdout: systemdObservation(456),
        stderr: '',
      }));
    let calls = 0;
    const pending = f.inspector.prepare(f.operation, () => {
      if (failure === 'revoked' && ++calls > 1) throw new Error('revoked');
    });
    if (failure === 'revoked') await expect(pending).rejects.toThrow('revoked');
    else await pending;
    expect(statSync(marker).mode & 0o777).toBe(0o664);
  },
);

it('refuses unavailable managers and mismatched live PIDs despite a valid marker', async () => {
  const f = setup();
  writeFileSync(join(f.home, 'supervisor'), 'systemd');
  f.run.mockImplementationOnce(async () => {
    throw new Error('manager unavailable');
  });
  expect((await f.inspector.inspect(f.operation)).blockers).toEqual([
    { code: 'supervisor_unavailable', target: 'updater' },
  ]);
  f.run.mockImplementation(async () => ({
    exitCode: 0,
    stdout: systemdObservation(456),
    stderr: '',
  }));
  expect((await f.inspector.inspect(f.operation)).blockers).toEqual([
    { code: 'daemon_supervision_unknown', target: 'daemon' },
  ]);
});
