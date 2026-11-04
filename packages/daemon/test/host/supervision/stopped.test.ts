import { expect, it, vi } from 'vitest';
import { resetServiceStartLimit } from '../../../src/host/supervision/stopped.js';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';

const target = { kind: 'systemd' as const, name: 'puddled.service', domain: null };
const observation =
  'Id=puddled.service\nLoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nNeedDaemonReload=no\nResult=start-limit-hit\n';

it.each([
  observation + 'MainPID=0\n',
  observation.replace('MainPID=0', 'MainPID=123'),
  observation.replace('Id=puddled.service', 'Id=other.service'),
  observation.replace('NeedDaemonReload=no', 'NeedDaemonReload=yes'),
  observation.replace('SubState=failed', 'SubState=auto-restart'),
  observation.replace('LoadState=loaded', 'LoadState=not-found'),
  observation.replace('Result=start-limit-hit\n', ''),
])('refuses ambiguous or live service evidence before resetting', async (stdout) => {
  const run = vi.fn<CompilationCommandRunner>(async () => ({ exitCode: 0, stdout, stderr: '' }));
  await expect(
    resetServiceStartLimit('/unused-fixture-home', target, async () => {}, run),
  ).rejects.toThrow('positively stopped');
  expect(run.mock.calls.every(([command]) => command.args[1] === 'show')).toBe(true);
});

it('does not reset after the final authority or configuration check fails', async () => {
  const run = vi.fn<CompilationCommandRunner>(async () => ({
    exitCode: 0,
    stdout: observation,
    stderr: '',
  }));
  await expect(
    resetServiceStartLimit(
      '/unused-fixture-home',
      target,
      async () => {
        throw new Error('Authority changed');
      },
      run,
    ),
  ).rejects.toThrow('Authority changed');
  expect(run).toHaveBeenCalledOnce();
});

it('rejects a different result on the final observation instead of clearing new evidence', async () => {
  const run = vi
    .fn<CompilationCommandRunner>()
    .mockResolvedValueOnce({ exitCode: 0, stdout: observation, stderr: '' })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: observation.replace('start-limit-hit', 'exit-code'),
      stderr: '',
    });
  await expect(
    resetServiceStartLimit('/unused-fixture-home', target, async () => {}, run),
  ).rejects.toThrow('evidence changed');
  expect(run.mock.calls.every(([command]) => command.args[1] === 'show')).toBe(true);
});
