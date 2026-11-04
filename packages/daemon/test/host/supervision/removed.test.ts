import { describe, expect, it } from 'vitest';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { serviceIsRemoved } from '../../../src/host/supervision/removed.js';
import type { ServiceTarget } from '../../../src/host/supervision/target.js';

const target: ServiceTarget = { kind: 'systemd', name: 'puddler-fixture.service', domain: null };
const absent = `Id=${target.name}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\n`;

describe('confirmed service removal', () => {
  it.each([0, 4])('accepts exact missing systemd properties with status %s', async (exitCode) => {
    const calls: string[][] = [];
    const run: CompilationCommandRunner = async (command) => {
      calls.push(command.args);
      return command.args[1] === 'show-environment'
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode, stdout: absent, stderr: '' };
    };
    expect(await serviceIsRemoved('/tmp', target, run)).toBe(true);
    expect(calls).toEqual([
      ['--user', 'show-environment'],
      [
        '--user',
        'show',
        '--property=Id,LoadState,ActiveState,SubState,MainPID,NeedDaemonReload',
        target.name,
      ],
    ]);
  });

  it.each([
    ['loaded', absent.replace('not-found', 'loaded')],
    ['active', absent.replace('inactive', 'active')],
    ['stopping', absent.replace('SubState=dead', 'SubState=stop-sigterm')],
    ['process', absent.replace('MainPID=0', 'MainPID=123')],
    ['pending reload', absent.replace('NeedDaemonReload=no', 'NeedDaemonReload=yes')],
    ['different unit', absent.replace(target.name, 'unrelated.service')],
    ['missing identity', absent.replace(`Id=${target.name}\n`, '')],
    ['missing process', absent.replace('MainPID=0\n', '')],
    ['duplicate evidence', absent + 'MainPID=0\n'],
    ['unknown property', absent + 'FutureProperty=value\n'],
    ['diagnostics', 'Unit was not found.'],
  ])('rejects %s evidence', async (_label, stdout) => {
    const run: CompilationCommandRunner = async () => ({ exitCode: 0, stdout, stderr: '' });
    expect(await serviceIsRemoved('/tmp', target, run)).toBe(false);
  });

  it('requires a reachable systemd manager before using missing-unit evidence', async () => {
    const calls: string[][] = [];
    const run: CompilationCommandRunner = async (command) => {
      calls.push(command.args);
      return { exitCode: 4, stdout: absent, stderr: 'No user manager' };
    };
    await expect(serviceIsRemoved('/tmp', target, run)).rejects.toThrow(/failed/);
    expect(calls).toEqual([['--user', 'show-environment']]);
  });

  it.each([1, 3, 5, 125])(
    'rejects systemd status %s even with missing-unit text',
    async (exitCode) => {
      const run: CompilationCommandRunner = async (command) => ({
        exitCode: command.args[1] === 'show-environment' ? 0 : exitCode,
        stdout: absent,
        stderr: '',
      });
      await expect(serviceIsRemoved('/tmp', target, run)).rejects.toThrow(/failed/);
    },
  );

  it('shares launchd removal proof and does not accept a loaded idle job', async () => {
    const job: ServiceTarget = {
      kind: 'launchd',
      name: 'dev.puddle.test.removal',
      domain: 'gui/501',
    };
    let present = true;
    const run: CompilationCommandRunner = async (command) => ({
      exitCode: command.args[0] === 'print' && !present ? 113 : 0,
      stdout: '',
      stderr: '',
    });
    expect(await serviceIsRemoved('/tmp', job, run)).toBe(false);
    present = false;
    expect(await serviceIsRemoved('/tmp', job, run)).toBe(true);
  });
});
