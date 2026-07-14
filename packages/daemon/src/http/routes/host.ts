import { homedir, hostname, userInfo } from 'node:os';
import { Hono } from 'hono';
import type { HostInfo } from '@puddle/shared';

/** Who and where the daemon is — the UI's host indicator (SPEC §6). */
export function hostRoutes(): Hono {
  return new Hono().get('/', (c) =>
    c.json<HostInfo>({
      username: userInfo().username,
      // .local is mDNS noise on macOS, not identity.
      hostname: hostname().replace(/\.local$/, ''),
      home: homedir(),
    }),
  );
}
