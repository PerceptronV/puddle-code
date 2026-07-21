import { Hono } from 'hono';
import { createScratchpadRequestSchema, patchScratchpadRequestSchema } from '@puddle/shared';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { ScratchpadStore } from '../../db/stores/scratchpad.js';
import { idParam, parseBody } from '../validate.js';

export interface ScratchpadRouteDeps {
  scratchpad: ScratchpadStore;
  profiles: ProfileStore;
  projects: ProjectStore;
}

/**
 * The Scratchpad CRUD surface (SPEC §6/§11): a per-profile bank of prompts and
 * notes. `GET /?profile=&project=` lists the entries visible in that context
 * (profile-scoped plus the project's own); PATCH doubles as the drag-reorder
 * write (a fractional `position`). Ids are integers, so `:id` uses `idParam`.
 */
export function scratchpadRoutes(deps: ScratchpadRouteDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const profile = c.req.query('profile');
      if (profile === undefined) return c.json([]);
      const project = c.req.query('project');
      return c.json(deps.scratchpad.list(profile, project));
    })
    .post('/', async (c) => {
      const body = await parseBody(c, createScratchpadRequestSchema);
      deps.profiles.get(body.profile_id); // 404 guard
      if (body.project_id !== undefined) deps.projects.get(body.project_id);
      return c.json(deps.scratchpad.create(body), 201);
    })
    .patch('/:id', async (c) => {
      const id = idParam(c);
      deps.scratchpad.get(id); // 404 guard
      const body = await parseBody(c, patchScratchpadRequestSchema);
      if (body.project_id) deps.projects.get(body.project_id);
      return c.json(deps.scratchpad.update(id, body));
    })
    .delete('/:id', (c) => {
      deps.scratchpad.delete(idParam(c));
      return c.body(null, 204);
    });
}
