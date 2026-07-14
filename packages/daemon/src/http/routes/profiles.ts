import { Hono } from 'hono';
import {
  createProfileRequestSchema,
  patchProfileRequestSchema,
  patchProfileSettingsRequestSchema,
} from '@puddle/shared';
import { join } from 'node:path';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { RemovalStore } from '../../db/stores/removals.js';
import type { PuddlePaths } from '../../paths.js';
import { removeDirWithin } from '../fs-cleanup.js';
import { idParam, parseBody } from '../validate.js';

export function profileRoutes(deps: {
  profiles: ProfileStore;
  removals: RemovalStore;
  paths: PuddlePaths;
}): Hono {
  return new Hono()
    .get('/', (c) => c.json(deps.profiles.list()))
    .post('/', async (c) => {
      const body = await parseBody(c, createProfileRequestSchema);
      const profile = deps.profiles.create({
        name: body.name,
        branch_prefix: body.branch_prefix ?? '',
      });
      return c.json(profile, 201);
    })
    .patch('/:id', async (c) => {
      const body = await parseBody(c, patchProfileRequestSchema);
      return c.json(deps.profiles.setBranchPrefix(idParam(c), body.branch_prefix));
    })
    .delete('/:id', (c) => {
      // 409 while any of its sessions is non-archived; cascade otherwise.
      const removed = deps.removals.deleteProfile(idParam(c));
      removeDirWithin(deps.paths.profilesDir, join(deps.paths.profilesDir, removed.name));
      return c.body(null, 204);
    })
    .get('/:id/settings', (c) => c.json(deps.profiles.getSettings(idParam(c))))
    .patch('/:id/settings', async (c) => {
      const patch = await parseBody(c, patchProfileSettingsRequestSchema);
      return c.json(deps.profiles.patchSettings(idParam(c), patch));
    });
}
