import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { LeaseRegistry } from '../../src/security/leases.js';
import { bearerAuth, requestAuthority } from '../../src/security/middleware.js';

it('fails closed without request authority and observes revocation during a handler', async () => {
  const unguarded = new Hono();
  unguarded.get('/', (c) => c.json({ valid: requestAuthority(c)() }));
  expect(await (await unguarded.request('/')).json()).toEqual({ valid: false });

  const leases = new LeaseRegistry();
  try {
    const lease = leases.create();
    const app = new Hono();
    app.onError((_error, c) => c.body(null, 401));
    app.use('*', bearerAuth(leases));
    const observed: boolean[] = [];
    app.get('/', async (c) => {
      const valid = requestAuthority(c);
      observed.push(valid());
      await Promise.resolve();
      leases.revoke(lease.generation);
      observed.push(valid());
      return c.body(null, 204);
    });
    const response = await app.request('/', {
      headers: { authorization: `Bearer ${lease.token}` },
    });
    expect(response.status).toBe(401);
    expect(observed).toEqual([true, false]);
  } finally {
    leases.dispose();
  }
});
