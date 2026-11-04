import { beforeEach, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: run }));
import { TerminalProcessReader } from '../../src/pty/foreground-process.js';

let output: string[];
let reader: TerminalProcessReader;
beforeEach(() => {
  reader = new TerminalProcessReader();
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
  expect([...(await reader.read(100, 'first')).keys()]).toEqual([100, 200]);
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
    expect((await reader.read(100, 'first')).size).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it('discards a changed root and propagates inspection failure without substituting an empty successful scan', async () => {
  output.push('100 1 100 200 ttys000 S shell', '100 1 100 200 ttys001 S shell');
  expect((await reader.read(100, 'first')).size).toBe(0);
  run.mockImplementation(
    (_file: string, _args: string[], _options: unknown, done: (error: Error) => void) =>
      done(new Error('ps failed')),
  );
  await expect(reader.read(100, 'first')).rejects.toThrow('ps failed');
  await expect(reader.read(-1, 'first')).rejects.toThrow('Invalid');
});

it('uses one scoped scan per refresh after verifying the terminal and still observes background children', async () => {
  const root = '100 1 100 100 pts/12 Ss /bin/bash';
  const processes = root + '\n200 100 200 100 pts/12 S agent\n300 1 300 300 pts/13 S unrelated';
  output.push(root, processes, processes, root);
  expect([...(await reader.read(100, 'first')).keys()]).toEqual([100, 200]);
  expect([...(await reader.read(100, 'first')).keys()]).toEqual([100, 200]);
  expect([...(await reader.read(100, 'first')).keys()]).toEqual([100]);
  expect(run.mock.calls.map((call) => call[1].slice(1, 3))).toEqual([
    ['-p', '100'],
    ['-t', 'pts/12'],
    ['-t', 'pts/12'],
    ['-t', 'pts/12'],
  ]);
});

it.each(['generation', 'pid'])(
  'does not reuse the cached terminal after a %s replacement',
  async (replacement) => {
    output.push('100 1 100 100 pts/12 Ss shell', '100 1 100 100 pts/12 Ss shell');
    await reader.read(100, 'first');
    const pid = replacement === 'pid' ? 101 : 100;
    output.push(`${pid} 1 ${pid} ${pid} pts/13 Ss shell`, `${pid} 1 ${pid} ${pid} pts/13 Ss shell`);
    expect([
      ...(await reader.read(pid, replacement === 'generation' ? 'second' : 'first')).keys(),
    ]).toEqual([pid]);
    expect(run.mock.calls[2]![1].slice(1, 3)).toEqual(['-p', String(pid)]);
  },
);

it.each(['missing', 'moved'])(
  'rediscovers a %s root without publishing the cached terminal population',
  async (change) => {
    output.push('100 1 100 100 pts/12 Ss shell', '100 1 100 100 pts/12 Ss shell');
    await reader.read(100, 'first');
    output.push(
      change === 'missing' ? '200 1 200 200 pts/12 S unrelated' : '100 1 100 100 pts/13 Ss shell',
      '100 1 100 100 pts/13 Ss shell',
      '100 1 100 100 pts/13 Ss shell',
    );
    expect([...(await reader.read(100, 'first')).keys()]).toEqual([100]);
    expect(run.mock.calls.slice(2).map((call) => call[1].slice(1, 3))).toEqual([
      ['-t', 'pts/12'],
      ['-p', '100'],
      ['-t', 'pts/13'],
    ]);
  },
);

it('propagates a cached inspection failure and requires a fresh root lookup afterwards', async () => {
  const root = '100 1 100 100 pts/12 Ss shell';
  output.push(root, root);
  await reader.read(100, 'first');
  run.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, done: (error: Error) => void) =>
      done(new Error('ps failed')),
  );
  await expect(reader.read(100, 'first')).rejects.toThrow('ps failed');
  output.push(root, root);
  expect([...(await reader.read(100, 'first')).keys()]).toEqual([100]);
  expect(run.mock.calls[3]![1].slice(1, 3)).toEqual(['-p', '100']);
});

it('discards a scan and its cached identity when disposed during an asynchronous lookup', async () => {
  const root = '100 1 100 100 pts/12 Ss shell';
  output.push(root, root);
  await reader.read(100, 'first');
  let finish!: (error: Error | null, stdout: string) => void;
  run.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, done: typeof finish) => {
      finish = done;
    },
  );
  const pending = reader.read(100, 'first');
  reader.dispose();
  finish(null, root);
  expect((await pending).size).toBe(0);
  expect((await reader.read(100, 'first')).size).toBe(0);
  expect(run).toHaveBeenCalledTimes(3);
});
