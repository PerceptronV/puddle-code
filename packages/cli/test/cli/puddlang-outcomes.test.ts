import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { PuddlangClient } from '../../src/puddlang/client.js';
import type { ConnectionAuthority } from '../../src/lib/auth/connection-authority.js';

afterEach(() => vi.unstubAllGlobals());
const run = '00000000-0000-4000-8000-000000000001';
const fingerprint = 'a'.repeat(64);
const outcome = {
  operation_id: 7,
  runtime_id: '00000000-0000-4000-8000-000000000002',
  turn: 3,
  status: 'completed',
  retained: true,
  consumed: true,
  fingerprint,
  disposition: { action: 'read', fingerprint, at: '2026-11-04T00:00:00.000Z' },
};
const client = (protocol?: { major: number; minor: number }) =>
  new PuddlangClient(
    () => 12345,
    { credential: () => 'fixture-authority' } as ConnectionAuthority,
    '1234567890',
    protocol,
  );

it.each([
  undefined,
  { major: 26, minor: 0 },
  { major: 26, minor: 1 },
  { major: 25, minor: 99 },
  { major: 27, minor: 0 },
])(
  'refuses outcome controls before HTTP when the compatible feature is absent (%j)',
  async (protocol) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(client(protocol).outcomes(run)).rejects.toThrow(/26.1/);
    await expect(
      client(protocol).disposeOutcome(run, 7, { action: 'read', fingerprint }),
    ).rejects.toThrow(/26.1/);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('uses selected profile authority and exact explicit outcome identity without replay after a lost reply', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('reply lost after commit'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ outcomes: [outcome], next_after: null })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ outcome, result: { status: 'completed', reply: 'private response' } }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const c = client(PROTOCOL_VERSION);
  await expect(c.disposeOutcome(run, 7, { action: 'read', fingerprint })).rejects.toThrow(/lost/);
  expect(fetch).toHaveBeenCalledTimes(1);
  const listed = await c.outcomes(run, 6);
  expect(listed.outcomes[0]!.disposition?.action).toBe('read');
  expect(fetch.mock.calls[0]).toEqual([
    `http://127.0.0.1:12345/api/puddlang/1234567890/runs/${run}/outcomes/7`,
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'read', fingerprint }),
      headers: { authorization: 'Bearer fixture-authority', 'content-type': 'application/json' },
    }),
  ]);
  expect(fetch.mock.calls[1]![0]).toContain('/outcomes?after=6');
  expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'GET' });
  expect((await c.disposeOutcome(run, 7, { action: 'read', fingerprint })).result?.reply).toBe(
    'private response',
  );
});
