import { expect, it, vi } from 'vitest';
import {
  inspectRunningService,
  inspectServiceManager,
} from '../../../src/host/supervision/inspection.js';
import type { CompilationCommand } from '../../../src/compilation/process.js';
import { launchdObservation, systemdObservation } from '../../helpers/host-supervision.js';

const target = { kind: 'systemd' as const, name: 'puddled.service', domain: null };
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

it('checks current systemd process and invocation with bounded read-only arguments', async () => {
  const run = vi.fn(async (_command: CompilationCommand) => ok(systemdObservation(123)));
  expect(await inspectRunningService('/home', target, 123, run)).toMatchObject({
    pid: 123,
    invocation: 'a'.repeat(32),
    controlGroup: expect.stringContaining('/puddled.service'),
  });
  expect(run).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      file: 'systemctl',
      args: ['--user', 'show', expect.stringContaining('MainPID'), 'puddled.service'],
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    }),
  );
});

it.each([
  ['MainPID=123', 'MainPID=456'],
  ['MainPID=123', 'ExecMainPID=123'],
  ['LoadState=loaded', 'LoadState=not-found'],
  ['ActiveState=active', 'ActiveState=activating'],
  ['SubState=running', 'SubState=exited'],
  ['NeedDaemonReload=no', 'NeedDaemonReload=yes'],
  ['CanStop=yes', 'CanStop=no'],
  ['Id=puddled.service', 'Id=other.service'],
  [`InvocationID=${'a'.repeat(32)}`, 'InvocationID='],
  ['/app.slice/puddled.service', '/app.slice/../puddled.service'],
])('refuses unknown or stale systemd evidence: %s', async (from, to) => {
  await expect(
    inspectRunningService('/home', target, 123, async () =>
      ok(systemdObservation(123).replace(from, to)),
    ),
  ).rejects.toThrow();
});

it('rejects duplicate properties and manager failures without trying recovery', async () => {
  const run = vi.fn(async () => ok(`${systemdObservation(123)}MainPID=123\n`));
  await expect(inspectRunningService('/home', target, 123, run)).rejects.toThrow('Ambiguous');
  expect(run).toHaveBeenCalledOnce();
  await expect(
    inspectServiceManager('/home', 'systemd', 501, async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'manager unavailable',
    })),
  ).rejects.toThrow();
});

it('checks exact launchd registration by exit status and matches documented list columns', async () => {
  let listing = launchdObservation(123);
  const run = vi.fn(async (command: CompilationCommand) =>
    ok(
      command.args[0] === 'managername'
        ? 'Aqua\n'
        : command.args[0] === 'manageruid'
          ? '501\n'
          : command.args[0] === 'list'
            ? listing
            : 'opaque diagnostics, not parsed',
    ),
  );
  const service = { kind: 'launchd' as const, name: 'dev.puddle.puddled', domain: 'gui/501' };
  expect(await inspectRunningService('/home', service, 123, run)).toEqual({
    ...service,
    pid: 123,
    invocation: null,
    controlGroup: null,
  });
  expect(run.mock.calls.map(([command]) => command.args)).toEqual([
    ['managername'],
    ['manageruid'],
    ['print', 'gui/501/dev.puddle.puddled'],
    ['list'],
  ]);
  listing = launchdObservation(456);
  await expect(inspectRunningService('/home', service, 123, run)).rejects.toThrow('does not match');
  listing = `${launchdObservation(123)}123\t0\tdev.puddle.puddled\n`;
  await expect(inspectRunningService('/home', service, 123, run)).rejects.toThrow('does not match');
});

it('probes manager availability without reading environment values or starting services', async () => {
  const run = vi.fn(async (_command: CompilationCommand) => ok());
  expect(await inspectServiceManager('/home', 'systemd', 501, run)).toEqual({
    kind: 'systemd',
    domain: null,
  });
  expect(await inspectServiceManager('/home', 'launchd', 501, run)).toEqual({
    kind: 'launchd',
    domain: 'gui/501',
  });
  expect(run.mock.calls.map(([command]) => command.args)).toEqual([
    ['--user', 'show', '--property=Version'],
    ['print-disabled', 'gui/501'],
  ]);
  await expect(
    inspectRunningService('/home', { ...target, name: '--all' }, 123, run),
  ).rejects.toThrow('Invalid');
  await expect(inspectServiceManager('/home', 'launchd', -1, run)).rejects.toThrow('Invalid');
  expect(run).toHaveBeenCalledTimes(2);
});

it.each(['Background', 'different-user'])(
  'refuses launchd list evidence from %s even with a matching label and PID',
  async (context) => {
    const run = vi.fn(async (command: CompilationCommand) =>
      ok(
        command.args[0] === 'managername'
          ? context === 'Background'
            ? 'Background'
            : 'Aqua'
          : '502',
      ),
    );
    await expect(
      inspectRunningService(
        '/home',
        { kind: 'launchd', name: 'dev.puddle.puddled', domain: 'gui/501' },
        123,
        run,
      ),
    ).rejects.toThrow('GUI context');
    expect(run.mock.calls.map(([command]) => command.args)).toEqual([
      ['managername'],
      ['manageruid'],
    ]);
  },
);
