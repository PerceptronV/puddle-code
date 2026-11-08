import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  huddleStartSchema,
  huddleTriggerReportSchema,
  huddleAutoStartSchema,
  huddleRecoverSchema,
  huddleRevisionReviewSchema,
  huddleRetainedRevisionRequestSchema,
  huddleRetainedRevisionSchema,
  huddleDiffReviewSchema,
  huddleReviewSchema,
  huddleReadoutObserveSchema,
  huddleReadoutObserveAcceptedSchema,
  huddleApplySchema,
  huddleRunSchema,
  huddleLifecycleCommandSchema,
  huddleRuntimeInspectionSchema,
  huddleHistoryRequestSchema,
  huddleHistoryOwnersRequestSchema,
  huddleHistoryOwnersSchema,
  huddleRetainedHistoryRequestSchema,
  huddleRetainedHistorySchema,
  huddleHistoryPageSchema,
  huddleRunAcceptedSchema,
  huddleStoppedSchema,
  sessionId,
} from '@puddle/shared';
import type { HuddleExecutionService } from '../../../../huddle/execution/service.js';
import { requestAuthority } from '../../../../security/middleware.js';
import { hexIdParam, parseBody } from '../../../validate.js';
import { ApiError } from '../../../errors.js';
import { localHuddleAccess } from './access.js';

export function huddleExecutionRoutes(service: HuddleExecutionService): Hono {
  return new Hono()
    .use('*', localHuddleAccess)
    .use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }))
    .use('/:profile/sessions/:sid/*', async (c, next) => {
      if (!sessionId.safeParse(c.req.param('sid')).success)
        throw ApiError.badRequest('invalid_id', 'Choose a huddle session');
      await next();
    })
    .get('/:profile/sessions/:sid/runtime', async (c) =>
      c.json(
        huddleRuntimeInspectionSchema.parse(
          await service.inspect(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            requestAuthority(c),
            c.req.query('include_readout_observation') === 'true',
            c.req.query('include_custom_triggers') === 'true',
            c.req.query('include_recovery') === 'true',
            c.req.query('include_auto_start') === 'true',
            c.req.query('include_trigger_inspection') === 'true',
            c.req.query('include_crash_recovery') === 'true',
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/triggers', async (c) =>
      c.json(
        huddleTriggerReportSchema.parse(
          await service.triggers(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleLifecycleCommandSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/revision', async (c) =>
      c.json(
        huddleReviewSchema.parse(
          await service.reviewRevision(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleRevisionReviewSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/diff', async (c) =>
      c.json(
        huddleReviewSchema.parse(
          await service.reviewDiff(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleDiffReviewSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/recover', async (c) =>
      c.json(
        huddleRuntimeInspectionSchema.parse(
          await service.recover(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleRecoverSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/start', async (c) =>
      c.json(
        huddleRuntimeInspectionSchema.parse(
          await service.start(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleStartSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/apply', async (c) =>
      c.json(
        huddleRuntimeInspectionSchema.parse(
          await service.apply(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleApplySchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/auto-start', async (c) =>
      c.json(
        huddleRuntimeInspectionSchema.parse(
          await service.autoStart(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleAutoStartSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/rearm', async (c) =>
      c.json(
        huddleRuntimeInspectionSchema.parse(
          await service.rearm(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleLifecycleCommandSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/run', async (c) =>
      c.json(
        huddleRunAcceptedSchema.parse(
          await service.run(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleRunSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/interrupt', async (c) =>
      c.json(
        huddleRuntimeInspectionSchema.parse(
          await service.interrupt(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleLifecycleCommandSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/stop', async (c) =>
      c.json(
        huddleStoppedSchema.parse(
          await service.stop(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleLifecycleCommandSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/revision/retained', async (c) =>
      c.json(
        huddleRetainedRevisionSchema.parse(
          await service.retainedRevision(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleRetainedRevisionRequestSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/history/owners', async (c) =>
      c.json(
        huddleHistoryOwnersSchema.parse(
          service.historyOwners(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleHistoryOwnersRequestSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/history/retained', async (c) =>
      c.json(
        huddleRetainedHistorySchema.parse(
          await service.retainedHistory(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleRetainedHistoryRequestSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/history', async (c) =>
      c.json(
        huddleHistoryPageSchema.parse(
          await service.history(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleHistoryRequestSchema),
            requestAuthority(c),
          ),
        ),
      ),
    )
    .post('/:profile/sessions/:sid/readouts/observe', async (c) =>
      c.json(
        huddleReadoutObserveAcceptedSchema.parse(
          await service.observeReadout(
            hexIdParam(c, 'profile'),
            c.req.param('sid'),
            await parseBody(c, huddleReadoutObserveSchema),
            requestAuthority(c),
          ),
        ),
      ),
    );
}
