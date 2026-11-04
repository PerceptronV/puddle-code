import {
  cockpitHostUpdateReplySchema,
  type CockpitHostUpdateReply,
  type HostUpdateReply,
} from '@puddle/shared';

/** Browser presentation contains no stage receipts, worker identities or private target paths. */
export function presentHostUpdate(reply: HostUpdateReply): CockpitHostUpdateReply {
  const source = reply.operation;
  const operation = source
    ? {
        id: source.id,
        revision: source.revision,
        created_at: source.created_at,
        updated_at: source.updated_at,
        phase: source.phase,
        targets: source.targets,
        staged:
          source.stages.length === source.targets.length &&
          source.stages.every((stage) => stage.record.checksum_verified),
        dispatched: source.dispatch_id !== null,
        message: source.message,
      }
    : null;
  return cockpitHostUpdateReplySchema.parse(
    reply.ok
      ? {
          ok: true,
          operation,
          ...(reply.review
            ? {
                review: {
                  ...reply.review,
                  blockers: reply.review.blockers.map(({ code }) => ({ code })),
                },
              }
            : {}),
          ...(reply.recovery ? { recovery: reply.recovery } : {}),
        }
      : { ok: false, code: reply.code, operation },
  );
}
