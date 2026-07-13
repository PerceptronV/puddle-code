import { Hono } from 'hono';
import type { VersionResponse } from '@puddle/shared';

export function versionRoutes(version: string): Hono {
  return new Hono().get('/', (c) => c.json<VersionResponse>({ version }));
}
