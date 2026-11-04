import { expect, it } from 'vitest';
import { supportsApplicationFeature } from '../src/protocol.js';

it.each([7, 10, 11, 12, 14, 15, 17, 18, 19, 20])(
  'preserves the 25.%i feature floor when a compatible application major resets its minor',
  (minor) => {
    const introduced = { major: 25, minor };
    const originalClient = { major: 25, minor: 20 };
    const nextClient = { major: 26, minor: 0 };
    expect(
      supportsApplicationFeature({ major: 25, minor: minor - 1 }, introduced, originalClient),
    ).toBe(false);
    expect(supportsApplicationFeature(introduced, introduced, originalClient)).toBe(true);
    expect(supportsApplicationFeature({ major: 26, minor: 0 }, introduced, nextClient)).toBe(true);
    expect(supportsApplicationFeature({ major: 26, minor: 3 }, introduced, nextClient)).toBe(true);
    // A feature floor never relaxes the separate application handshake boundary.
    expect(supportsApplicationFeature({ major: 25, minor: 99 }, introduced, nextClient)).toBe(
      false,
    );
    expect(supportsApplicationFeature({ major: 27, minor: 0 }, introduced, nextClient)).toBe(false);
    expect(supportsApplicationFeature(undefined, introduced, nextClient)).toBe(false);
    expect(supportsApplicationFeature(null, introduced, nextClient)).toBe(false);
  },
);

it('does not enable a future feature for an otherwise compatible peer', () => {
  const client = { major: 26, minor: 0 };
  expect(supportsApplicationFeature(client, { major: 26, minor: 1 }, client)).toBe(false);
  expect(supportsApplicationFeature(client, { major: 27, minor: 0 }, client)).toBe(false);
});
