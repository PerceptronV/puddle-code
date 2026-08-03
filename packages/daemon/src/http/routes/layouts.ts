import { Hono } from 'hono';
import { createLayoutRequestSchema, patchLayoutRequestSchema } from '@puddle/shared';
import type { LayoutStore } from '../../db/stores/layouts.js';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import { idParam, parseBody } from '../validate.js';

export interface LayoutRouteDeps {
  layouts: LayoutStore;
  profiles: ProfileStore;
  projects: ProjectStore;
}

/**
 * The saved-layouts CRUD surface (SPEC §6/§11), shaped exactly like the
 * Scratchpad's: `GET /?profile=&project=` lists the layouts visible in that
 * context (profile-scoped plus the project's own; without `project`, all of
 * the profile's); PATCH is rename and/or save-over. Ids are integers, so
 * `:id` uses `idParam`.
 */
export function layoutRoutes(deps: LayoutRouteDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const profile = c.req.query('profile');
      if (profile === undefined) return c.json([]);
      const project = c.req.query('project');
      return c.json(deps.layouts.list(profile, project));
    })
    .post('/', async (c) => {
      const body = await parseBody(c, createLayoutRequestSchema);
      deps.profiles.get(body.profile_id); // 404 guard
      if (body.project_id !== undefined) deps.projects.get(body.project_id);
      return c.json(deps.layouts.create(body), 201);
    })
    .patch('/:id', async (c) => {
      const id = idParam(c);
      deps.layouts.get(id); // 404 guard
      const body = await parseBody(c, patchLayoutRequestSchema);
      return c.json(deps.layouts.update(id, body));
    })
    .delete('/:id', (c) => {
      deps.layouts.delete(idParam(c));
      return c.body(null, 204);
    });
}
