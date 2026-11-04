import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  puddlangStartSchema,
  puddlangContextSchema,
  puddlangRunSchema,
  puddlangEventsSchema,
  puddlangOutcomesSchema,
  puddlangOutcomeOperationSchema,
  puddlangOutcomeRequestSchema,
  puddlangOutcomeResponseSchema,
} from '@puddle/shared';
import type { PuddlangService } from '../../../puddlang/service.js';
import { hexIdParam, parseBody } from '../../validate.js';
import { ApiError } from '../../errors.js';
import { requestAuthority } from '../../../security/middleware.js';

/** Initially local/SSH only; remote profile middleware rejects this namespace. */
export function puddlangRoutes(service: PuddlangService): Hono {
  return new Hono()
    .use('*', bodyLimit({ maxSize: 1024 * 1024 }))
    .get('/:profile/context', (c) =>
      c.json(puddlangContextSchema.parse(service.context(hexIdParam(c, 'profile')))),
    )
    .post('/:profile/runs', async (c) => {
      const input = await parseBody(c, puddlangStartSchema);
      return c.json(puddlangRunSchema.parse(service.start(hexIdParam(c, 'profile'), input)), 202);
    })
    .get('/:profile/runs/:id', (c) =>
      c.json(
        puddlangRunSchema.parse(service.store.get(hexIdParam(c, 'profile'), c.req.param('id'))),
      ),
    )
    .get('/:profile/runs/:id/events', (c) => {
      const after = Number(c.req.query('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw ApiError.badRequest('invalid_cursor', 'after must be a non-negative integer');
      return c.json(
        puddlangEventsSchema.parse(
          service.store.events(hexIdParam(c, 'profile'), c.req.param('id'), after),
        ),
      );
    })
    .get('/:profile/runs/:id/outcomes', (c) => {
      const raw = c.req.query('after');
      const after = raw === undefined ? undefined : Number(raw);
      if (after !== undefined && !puddlangOutcomeOperationSchema.safeParse(after).success)
        throw ApiError.badRequest('invalid_cursor', 'after must be a safe integer operation id');
      return c.json(
        puddlangOutcomesSchema.parse(
          service.store.outcomes.list(hexIdParam(c, 'profile'), c.req.param('id'), after),
        ),
      );
    })
    .post('/:profile/runs/:id/outcomes/:operation', async (c) => {
      const operation = Number(c.req.param('operation'));
      if (!puddlangOutcomeOperationSchema.safeParse(operation).success)
        throw ApiError.badRequest('invalid_operation', 'operation must be a safe integer');
      const input = await parseBody(c, puddlangOutcomeRequestSchema);
      return c.json(
        puddlangOutcomeResponseSchema.parse(
          service.store.outcomes.dispose(
            hexIdParam(c, 'profile'),
            c.req.param('id'),
            operation,
            input,
            requestAuthority(c),
          ),
        ),
      );
    })
    .post('/:profile/runs/:id/cancel', async (c) =>
      c.json(
        puddlangRunSchema.parse(await service.cancel(hexIdParam(c, 'profile'), c.req.param('id'))),
      ),
    );
}
