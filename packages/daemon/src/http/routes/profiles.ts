import { Hono } from 'hono';
import { createProfileRequestSchema, patchProfileSettingsRequestSchema } from '@puddle/shared';
import type { ProfileStore } from '../../db/stores/profiles.js';
import { idParam, parseBody } from '../validate.js';

export function profileRoutes(deps: { profiles: ProfileStore }): Hono {
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
    .get('/:id/settings', (c) => c.json(deps.profiles.getSettings(idParam(c))))
    .patch('/:id/settings', async (c) => {
      const patch = await parseBody(c, patchProfileSettingsRequestSchema);
      return c.json(deps.profiles.patchSettings(idParam(c), patch));
    });
}
