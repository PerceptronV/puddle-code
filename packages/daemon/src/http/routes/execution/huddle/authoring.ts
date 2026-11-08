import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  huddleAvailabilitySchema,
  huddleCreateSchema,
  huddleDiscoverySchema,
  huddleDocumentSchema,
  huddleLocationSchema,
  huddleOpenedSchema,
  huddleOpenSchema,
  huddleSaveSchema,
  huddleSaveSourceSchema,
  huddleSourceSchema,
  huddleInstallTemplateSchema,
  huddleInstalledTemplateSchema,
  HUDDLE_LIMITS,
} from '@puddle/shared';
import type { HuddleService } from '../../../../huddle/control/service.js';
import { requestAuthority } from '../../../../security/middleware.js';
import { hexIdParam, parseBody } from '../../../validate.js';
import { ApiError } from '../../../errors.js';
import { localHuddleAccess } from './access.js';

/** Remote profile leases cannot enter this namespace, even through a direct daemon request. */
export function huddleAuthoringRoutes(service: HuddleService): Hono {
  return new Hono()
    .use('*', localHuddleAccess)
    .use('/:profile/definitions', bodyLimit({ maxSize: HUDDLE_LIMITS.fileBytes + 16 * 1024 }))
    .use('/:profile/definitions/*', (c, next) =>
      bodyLimit({
        maxSize: HUDDLE_LIMITS.fileBytes * (c.req.path.endsWith('/source') ? 6 : 1) + 16 * 1024,
      })(c, next),
    )
    .use('/:profile/open', bodyLimit({ maxSize: HUDDLE_LIMITS.fileBytes + 16 * 1024 }))
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
    .get('/:profile/definitions/:id/source', async (c) => {
      const input = huddleOpenSchema.safeParse({ ...c.req.query(), huddle_id: c.req.param('id') });
      if (!input.success)
        throw ApiError.badRequest('invalid_location', 'Choose a project, worktree and huddle id');
      return c.json(
        huddleSourceSchema.parse(
          await service.source(hexIdParam(c, 'profile'), input.data, requestAuthority(c)),
        ),
      );
    })
    .put('/:profile/definitions/:id/source', async (c) => {
      const body = await parseBody(c, huddleSaveSourceSchema.omit({ huddle_id: true }));
      const input = huddleSaveSourceSchema.safeParse({ ...body, huddle_id: c.req.param('id') });
      if (!input.success) throw ApiError.badRequest('invalid_location', 'Choose a valid huddle id');
      return c.json(
        huddleSourceSchema.parse(
          await service.saveSource(hexIdParam(c, 'profile'), input.data, requestAuthority(c)),
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
    })
    .post('/:profile/definitions/:id/components', async (c) => {
      const body = await parseBody(c, huddleInstallTemplateSchema.omit({ huddle_id: true }));
      const input = huddleInstallTemplateSchema.safeParse({
        ...body,
        huddle_id: c.req.param('id'),
      });
      if (!input.success) throw ApiError.badRequest('invalid_location', 'Choose a valid huddle id');
      return c.json(
        huddleInstalledTemplateSchema.parse(
          await service.installTemplate(hexIdParam(c, 'profile'), input.data, requestAuthority(c)),
        ),
      );
    })
    .put('/:profile/definitions/:id', async (c) => {
      const input = await parseBody(c, huddleSaveSchema.omit({ huddle_id: true }));
      const request = huddleSaveSchema.safeParse({ ...input, huddle_id: c.req.param('id') });
      if (!request.success)
        throw ApiError.badRequest('invalid_location', 'Choose a valid huddle id');
      return c.json(
        huddleDocumentSchema.parse(
          await service.save(hexIdParam(c, 'profile'), request.data, requestAuthority(c)),
        ),
      );
    });
}
