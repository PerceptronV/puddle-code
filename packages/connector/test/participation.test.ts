import { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { controlRequestSchema, PROTOCOL_VERSION } from '@puddle/shared';

it('never renews manual authority autonomously and expires it even when timers were suspended', async () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const received: string[] = [];
  const generation = crypto.randomUUID();
  const channel = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const request = controlRequestSchema.parse(JSON.parse(String(chunk)));
      received.push(request.t);
      if (request.t !== 'close')
        this.push(
          JSON.stringify({
            t: 'authority',
            generation,
            token: `cn_${'a'.repeat(64)}`,
            validForMs: 45_000,
            port: 7434,
            version: { version: '0.1.13', protocol: PROTOCOL_VERSION },
          }) + '\n',
        );
      callback();
    },
  });
  const authority = new HostControlClient(async () => channel, false);
  try {
    await authority.establish();
    const detached = vi.fn();
    const resource = authority.resource(detached);
    now = 15_000;
    expect(received).toEqual(['open']);
    expect(authority.participate([resource.id], 0)).toBe(false);
    expect(authority.participate(['f'.repeat(64)], now)).toBe(false);
    expect(authority.participate([resource.id], now)).toBe(true);
    expect(received).toEqual(['open', 'renew']);
    now = 60_000; // No interval callback ran: the dispatch check still expires it.
    expect(authority.state).toBe('upstream_expired');
    expect(detached).toHaveBeenCalledOnce();
    expect(() => authority.credential()).toThrow();
    expect(authority.participate([resource.id])).toBe(false);
  } finally {
    authority.close();
    clock.mockRestore();
  }
});
