import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type {
  CompilationCommand,
  CompilationCommandRunner,
} from '../../../src/compilation/process.js';
import { inspectRunningService } from '../../../src/host/supervision/inspection.js';
import {
  prepareServiceReplacement,
  serviceIsStopped,
  startReplacementService,
  stopServiceForReplacement,
} from '../../../src/host/supervision/replacement.js';
import { systemdObservation, launchdObservation } from '../../helpers/host-supervision.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(kind: 'systemd' | 'launchd') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-service-replacement-'));
  homes.push(home);
  const service = {
    kind,
    name: kind === 'systemd' ? 'puddled.service' : 'dev.puddle.puddled',
    domain: kind === 'launchd' ? `gui/${process.getuid!()}` : null,
  };
  const definitionPath = join(home, 'daemon.plist');
  const plist = {
    Label: service.name,
    ProgramArguments: [join(home, 'bin/current/puddled')],
    EnvironmentVariables: { PRESERVE: 'existing custom environment' },
  };
  writeFileSync(definitionPath, JSON.stringify(plist), { mode: 0o600 });
  const state = {
    stopped: false,
    changed: false,
    pid: 123,
    invocation: 'a'.repeat(32),
    printExit: 113,
    lost: false,
  };
  const commands: CompilationCommand[] = [];
  const run: CompilationCommandRunner = async (command) => {
    commands.push(command);
    const action = command.args[kind === 'systemd' ? 1 : 0];
    let stdout = '';
    if (command.file === '/usr/bin/plutil') stdout = JSON.stringify(plist);
    else if (action === 'cat')
      stdout = state.changed ? 'Changed configuration' : '[Service]\nEnvironment=PRESERVE=existing';
    else if (action === 'managername') stdout = 'Aqua';
    else if (action === 'manageruid') stdout = String(process.getuid!());
    else if (action === 'list') stdout = launchdObservation(state.pid);
    else if (action === 'show')
      stdout = state.stopped
        ? `Id=${service.name}\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\n`
        : systemdObservation(state.pid).replace('a'.repeat(32), state.invocation);
    else if (action === 'print' && state.stopped)
      return { exitCode: state.printExit, stdout: '', stderr: '' };
    else if (action === 'stop' || action === 'bootout') {
      state.stopped = true;
      if (state.lost) throw new Error('Stop reply lost');
    } else if (action === 'start' || action === 'bootstrap') state.stopped = false;
    return { exitCode: 0, stdout, stderr: '' };
  };
  const prepare = async () =>
    prepareServiceReplacement(home, await inspectRunningService(home, service, 123, run), {
      definitionPath,
      run,
    });
  return { home, service, state, commands, run, prepare, definitionPath, plist };
}

it.each(['systemd', 'launchd'] as const)(
  'preserves %s configuration and uses one exact supervisor stop/start',
  async (kind) => {
    const f = fixture(kind);
    const evidence = await f.prepare();
    expect(JSON.stringify(evidence)).not.toContain('existing');
    let checked = false;
    await stopServiceForReplacement(
      f.home,
      evidence,
      () => {
        checked = true;
      },
      f.run,
    );
    expect(checked).toBe(true);
    expect(await serviceIsStopped(f.home, evidence, f.run)).toBe(true);
    await startReplacementService(f.home, evidence, f.run);
    const mutations = f.commands.filter((command) =>
      command.args.some((arg) => ['stop', 'bootout', 'start', 'bootstrap'].includes(arg)),
    );
    expect(mutations.map((command) => command.args)).toEqual(
      kind === 'systemd'
        ? [
            ['--user', 'stop', f.service.name],
            ['--user', 'start', f.service.name],
          ]
        : [
            ['bootout', `${f.service.domain}/${f.service.name}`],
            ['bootstrap', f.service.domain, f.definitionPath],
          ],
    );
  },
);

it.each(['systemd', 'launchd'] as const)(
  'refuses changed %s definitions before stop and before start',
  async (kind) => {
    const f = fixture(kind);
    const evidence = await f.prepare();
    const change = () =>
      kind === 'systemd'
        ? (f.state.changed = true)
        : writeFileSync(f.definitionPath, `${JSON.stringify(f.plist)}\n`);
    change();
    await expect(stopServiceForReplacement(f.home, evidence, () => {}, f.run)).rejects.toThrow(
      'configuration changed',
    );
    f.state.stopped = true;
    await expect(startReplacementService(f.home, evidence, f.run)).rejects.toThrow(
      'configuration changed',
    );
    expect(
      f.commands.some(
        (command) =>
          command.args.includes('stop') ||
          command.args.includes('bootout') ||
          command.args.includes('start') ||
          command.args.includes('bootstrap'),
      ),
    ).toBe(false);
  },
);

it('rejects PID/invocation replacement and failed final authority checks before mutation', async () => {
  const f = fixture('systemd');
  const evidence = await f.prepare();
  f.state.pid++;
  await expect(stopServiceForReplacement(f.home, evidence, () => {}, f.run)).rejects.toThrow(
    'running daemon',
  );
  f.state.pid--;
  f.state.invocation = 'b'.repeat(32);
  await expect(stopServiceForReplacement(f.home, evidence, () => {}, f.run)).rejects.toThrow(
    'replaced',
  );
  f.state.invocation = evidence.invocation!;
  await expect(
    stopServiceForReplacement(
      f.home,
      evidence,
      () => {
        throw new Error('Approval changed');
      },
      f.run,
    ),
  ).rejects.toThrow('Approval changed');
  expect(f.state.stopped).toBe(false);
});

it('never retries a lost stop reply or treats arbitrary launchd failures as absence', async () => {
  const f = fixture('launchd');
  const evidence = await f.prepare();
  f.state.lost = true;
  await expect(stopServiceForReplacement(f.home, evidence, () => {}, f.run)).rejects.toThrow(
    'reply lost',
  );
  expect(f.commands.filter((command) => command.args[0] === 'bootout')).toHaveLength(1);
  f.state.printExit = 5;
  await expect(serviceIsStopped(f.home, evidence, f.run)).rejects.toThrow('command failed');
});
