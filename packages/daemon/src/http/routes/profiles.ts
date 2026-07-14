import { Hono } from 'hono';
import {
  DEFAULT_BRANCH_PREFIX,
  createProfileRequestSchema,
  patchProfileRequestSchema,
  patchProfileSettingsRequestSchema,
} from '@puddle/shared';
import { join } from 'node:path';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { RemovalStore } from '../../db/stores/removals.js';
import type { PuddlePaths } from '../../paths.js';
import { removeDirWithin } from '../fs-cleanup.js';
import { hexIdParam, parseBody } from '../validate.js';

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
        // Omitted → the puddle/ default; an explicit '' still means no prefix.
        branch_prefix: body.branch_prefix ?? DEFAULT_BRANCH_PREFIX,
      });
      return c.json(profile, 201);
    })
    .patch('/:id', async (c) => {
      const body = await parseBody(c, patchProfileRequestSchema);
      return c.json(deps.profiles.setBranchPrefix(hexIdParam(c), body.branch_prefix));
    })
    .delete('/:id', (c) => {
      const id = hexIdParam(c);
      // 409 while any of its sessions is non-archived; cascade otherwise.
      deps.removals.deleteProfile(id);
      removeDirWithin(deps.paths.profilesDir, join(deps.paths.profilesDir, id));
      return c.body(null, 204);
    })
    .get('/:id/settings', (c) => c.json(deps.profiles.getSettings(hexIdParam(c))))
    .patch('/:id/settings', async (c) => {
      const patch = await parseBody(c, patchProfileSettingsRequestSchema);
      return c.json(deps.profiles.patchSettings(hexIdParam(c), patch));
    });
}
