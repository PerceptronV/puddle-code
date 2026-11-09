import { expect, it, vi } from 'vitest';
import { packageDesktop } from '../../scripts/package.mjs';

it('retries transient downloads with bounded backoff and never publishes', async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ code: 1, output: 'Response code 504 (Gateway Time-out)' })
    .mockResolvedValueOnce({ code: 1, output: 'ECONNRESET' })
    .mockResolvedValueOnce({ code: 0, output: '' });
  const wait = vi.fn();
  expect(await packageDesktop(['-c.mac.identity=-'], run, wait)).toBe(0);
  expect(run.mock.calls).toEqual(Array(3).fill([['-c.mac.identity=-', '--publish', 'never']]));
  expect(wait.mock.calls).toEqual([[10_000], [20_000]]);
});

it('stops after three transient failures and does not retry permanent failures or signals', async () => {
  for (const [result, attempts] of [
    [{ code: 1, output: 'Response code 503' }, 3],
    [{ code: 2, output: 'Invalid configuration' }, 1],
    [{ code: 1, output: 'checksum mismatch' }, 1],
    [{ code: null, signal: 'SIGTERM', output: 'ETIMEDOUT' }, 1],
  ] as const) {
    const run = vi.fn().mockResolvedValue(result);
    expect(await packageDesktop([], run, vi.fn())).toBe(result.code || 1);
    expect(run).toHaveBeenCalledTimes(attempts);
  }
});

it.each(['--publish', '--publish=always', '-p', '-p=always'])(
  'rejects publishing override %s before starting the builder',
  async (arg) => {
    const run = vi.fn();
    await expect(packageDesktop([arg], run, vi.fn())).rejects.toThrow('Publishing');
    expect(run).not.toHaveBeenCalled();
  },
);
