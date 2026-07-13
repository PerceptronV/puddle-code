import { Hono } from 'hono';
import {
  archiveRequestSchema,
  createSessionRequestSchema,
  patchSessionRequestSchema,
  sessionStatusSchema,
} from '@puddle/shared';
import type { SessionService } from '../../sessions/service.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../validate.js';

export function sessionRoutes(deps: { service: SessionService }): Hono {
  return new Hono()
    .get('/', (c) => {
      const project = c.req.query('project');
      const statusRaw = c.req.query('status');
      const status = statusRaw !== undefined ? sessionStatusSchema.safeParse(statusRaw) : undefined;
      if (status && !status.success) {
        throw ApiError.badRequest('invalid_status', `unknown status '${statusRaw}'`);
      }
      return c.json(
        deps.service.list({
          project_id: project !== undefined ? Number(project) : undefined,
          status: status?.data,
        }),
      );
    })
    .post('/', async (c) => {
      const body = await parseBody(c, createSessionRequestSchema);
      return c.json(await deps.service.create(body), 201);
    })
    .get('/:id', (c) => c.json(deps.service.get(c.req.param('id'))))
    .patch('/:id', async (c) => {
      const body = await parseBody(c, patchSessionRequestSchema);
      return c.json(deps.service.rename(c.req.param('id'), body.title));
    })
    .post('/:id/resume', async (c) => c.json(await deps.service.resume(c.req.param('id'))))
    .post('/:id/kill', async (c) => c.json(await deps.service.kill(c.req.param('id'))))
    .post('/:id/archive', async (c) => {
      const body = await parseBody(c, archiveRequestSchema);
      return c.json(await deps.service.archive(c.req.param('id'), body.force));
    });
}
