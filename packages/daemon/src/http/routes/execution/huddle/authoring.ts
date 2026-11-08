import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  huddleAvailabilitySchema,
  huddleCreateSchema,
  huddleDiscoverySchema,
  huddleDocumentSchema,
  huddleLocationSchema,
  huddleOpenedSchema,
  huddleOpenSchema,
} from '@puddle/shared';
import type { HuddleService } from '../../../../huddle/control/service.js';
import { requestAuthority } from '../../../../security/middleware.js';
import { hexIdParam, parseBody } from '../../../validate.js';
import { ApiError } from '../../../errors.js';

/** Remote profile leases cannot enter this namespace, even through a direct daemon request. */
export function huddleAuthoringRoutes(service: HuddleService): Hono {
  const localOnly: MiddlewareHandler = async (c, next) => {
    if (c.get('remoteProfile'))
      throw new ApiError(403, 'profile_scope', 'Huddles currently require local or SSH access');
    await next();
  };
  return new Hono()
    .use('*', localOnly)
    .use('*', bodyLimit({ maxSize: 16 * 1024 }))
    .get('/:profile/availability', async (c) =>
      c.json(
        huddleAvailabilitySchema.parse(
          await service.availability(hexIdParam(c, 'profile'), requestAuthority(c)),
        ),
      ),
    )
    .get('/:profile/definitions', async (c) => {
      const input = huddleLocationSchema.safeParse(c.req.query());
      if (!input.success)
        throw ApiError.badRequest('invalid_location', 'Choose a project and worktree');
      return c.json(
        huddleDiscoverySchema.parse(
          await service.discover(hexIdParam(c, 'profile'), input.data, requestAuthority(c)),
        ),
      );
    })
    .get('/:profile/definitions/:id', async (c) => {
      const input = huddleOpenSchema.safeParse({ ...c.req.query(), huddle_id: c.req.param('id') });
      if (!input.success)
        throw ApiError.badRequest('invalid_location', 'Choose a project, worktree and huddle id');
      return c.json(
        huddleDocumentSchema.parse(
          await service.inspect(hexIdParam(c, 'profile'), input.data, requestAuthority(c)),
        ),
      );
    })
    .post('/:profile/definitions', async (c) => {
      const input = await parseBody(c, huddleCreateSchema);
      return c.json(
        huddleOpenedSchema.parse(
          await service.create(hexIdParam(c, 'profile'), input, requestAuthority(c)),
        ),
        201,
      );
    })
    .post('/:profile/open', async (c) => {
      const input = await parseBody(c, huddleOpenSchema);
      return c.json(
        huddleOpenedSchema.parse(
          await service.open(hexIdParam(c, 'profile'), input, requestAuthority(c)),
        ),
      );
    });
}
