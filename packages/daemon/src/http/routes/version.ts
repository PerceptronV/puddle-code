import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '@puddle/shared';
import type { VersionResponse } from '@puddle/shared';

export function versionRoutes(version: string): Hono {
  return new Hono().get('/', (c) =>
    c.json<VersionResponse>({ version, protocol: PROTOCOL_VERSION }),
  );
}
