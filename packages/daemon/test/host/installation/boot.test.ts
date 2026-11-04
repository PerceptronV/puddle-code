import { expect, it } from 'vitest';
import { readHostBootIdentity } from '@puddle/shared/node/host-control';

const boot = 'a1234567-b123-c123-d123-e12345678901';
it.each(['linux', 'darwin'] as const)(
  'reads only a bounded kernel UUID on %s',
  async (platform) => {
    const options = {
      platform,
      linux: () => boot.toUpperCase() + '\n',
      darwin: async () => boot.toUpperCase() + '\n',
    };
    expect(await readHostBootIdentity(options)).toBe(boot);
    for (const value of [
      '',
      '12345',
      '0'.repeat(36),
      '00000000-0000-0000-0000-000000000000',
      `${boot}\n${boot}`,
      ' '.repeat(129) + boot,
    ])
      expect(
        await readHostBootIdentity({ platform, linux: () => value, darwin: async () => value }),
      ).toBeNull();
  },
);

it('leaves unavailable identity unknown without falling back to a clock or PID', async () => {
  expect(await readHostBootIdentity({ platform: 'win32' })).toBeNull();
  expect(
    await readHostBootIdentity({
      platform: 'linux',
      linux: () => {
        throw new Error('unavailable');
      },
    }),
  ).toBeNull();
  expect(
    await readHostBootIdentity({
      platform: 'darwin',
      darwin: async () => {
        throw new Error('timeout');
      },
    }),
  ).toBeNull();
});
