import { beforeEach, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: run }));
import { readTerminalProcessSnapshot } from '../../src/pty/foreground-process.js';

let output: string[];
beforeEach(() => {
  output = [];
  run
    .mockReset()
    .mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        done: (error: Error | null, stdout: string) => void,
      ) => done(null, output.shift() ?? ''),
    );
});

it('looks up the owned root then inspects only its bounded terminal process set', async () => {
  output.push(
    '100 1 100 200 pts/12 Ss /bin/bash',
    [
      '100 1 100 200 pts/12 Ss /bin/bash',
      '200 100 200 200 pts/12 S+ agent',
      '300 1 300 300 pts/13 S+ unrelated',
    ].join('\n'),
  );
  expect([...(await readTerminalProcessSnapshot(100)).keys()]).toEqual([100, 200]);
  expect(run.mock.calls[0]?.slice(0, 3)).toEqual([
    'ps',
    ['-ww', '-p', '100', '-o', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,args='],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 },
  ]);
  expect(run.mock.calls[1]?.slice(0, 3)).toEqual([
    'ps',
    ['-ww', '-t', 'pts/12', '-o', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,args='],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 512 * 1024 },
  ]);
});

it.each(['?', '??', '-a', 'bad;tty'])(
  'does not inspect an absent or inadmissible terminal: %s',
  async (tty) => {
    output.push(`100 1 100 -1 ${tty} S shell`);
    expect((await readTerminalProcessSnapshot(100)).size).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it('discards a changed root and propagates inspection failure without substituting an empty successful scan', async () => {
  output.push('100 1 100 200 ttys000 S shell', '100 1 100 200 ttys001 S shell');
  expect((await readTerminalProcessSnapshot(100)).size).toBe(0);
  run.mockImplementation(
    (_file: string, _args: string[], _options: unknown, done: (error: Error) => void) =>
      done(new Error('ps failed')),
  );
  await expect(readTerminalProcessSnapshot(100)).rejects.toThrow('ps failed');
  await expect(readTerminalProcessSnapshot(-1)).rejects.toThrow('Invalid');
});
