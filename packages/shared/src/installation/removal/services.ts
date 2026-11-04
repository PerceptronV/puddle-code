import { z } from 'zod';
import { hostServiceReplacementSchema } from '../supervision.js';

const service = hostServiceReplacementSchema.shape;
const target = z
  .object({ kind: service.kind, name: service.name, domain: service.domain })
  .strict();
const process = target.extend({
  pid: service.pid,
  invocation: service.invocation,
  controlGroup: service.controlGroup,
});

/** Private host evidence only; no browser-selected service names, paths or commands. */
export const hostRemovalServiceReviewSchema = z
  .object({
    target,
    component: z.enum(['daemon', 'connector']),
    definition: z.string().min(1).max(4096),
    sourceDigest: service.definition_digest,
    definitionDigest: service.definition_digest,
    process: process.nullable(),
  })
  .strict()
  .superRefine((review, context) => {
    const observed = review.process;
    const expected = review.target;
    if (
      (expected.kind === 'systemd'
        ? expected.domain !== null || !expected.name.endsWith('.service')
        : expected.domain === null) ||
      (observed &&
        (observed.kind !== expected.kind ||
          observed.name !== expected.name ||
          observed.domain !== expected.domain ||
          (observed.kind === 'systemd'
            ? observed.invocation === null || observed.controlGroup === null
            : observed.invocation !== null || observed.controlGroup !== null)))
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent removal service evidence' });
  });
export type HostRemovalServiceReview = z.infer<typeof hostRemovalServiceReviewSchema>;

export const hostRemovalServiceActionSchema = z.enum([
  'disable-remote',
  'stop-connector',
  'stop-daemon',
  'unregister-connector',
  'unregister-daemon',
]);
export type HostRemovalServiceAction = z.infer<typeof hostRemovalServiceActionSchema>;

/** Durable service phase. This is neither runtime disposition nor file collection authority. */
export const hostRemovalServicesSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    release_path: z.string().min(1).max(4096),
    services: z
      .array(
        z
          .object({
            review: hostRemovalServiceReviewSchema,
            // The original may contain environment values. Keep it only in private host storage.
            source: z.string().min(1).max(87_384),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    actions: z
      .array(
        z
          .object({
            action: hostRemovalServiceActionSchema,
            state: z.enum(['planned', 'started', 'finished']),
          })
          .strict(),
      )
      .min(2)
      .max(5),
  })
  .strict()
  .superRefine((record, context) => {
    const components = record.services.map(({ review }) => review.component);
    const ordered = ['connector', 'daemon'].filter((component) =>
      components.includes(component as 'daemon' | 'connector'),
    );
    const plan = [
      ...(record.actions[0]?.action === 'disable-remote' ? ['disable-remote'] : []),
      ...ordered.map((component) => `stop-${component}`),
      ...ordered.map((component) => `unregister-${component}`),
    ];
    if (
      new Set(components).size !== components.length ||
      !components.includes('daemon') ||
      JSON.stringify(record.actions.map(({ action }) => action)) !== JSON.stringify(plan)
    )
      context.addIssue({
        code: 'custom',
        message: 'Removal service plan does not match its inventory',
      });
    let unfinished = false;
    for (const { state } of record.actions) {
      if (unfinished && state !== 'planned')
        context.addIssue({ code: 'custom', message: 'Removal actions are not a serial prefix' });
      if (state !== 'finished') unfinished = true;
    }
  });
export type HostRemovalServices = z.infer<typeof hostRemovalServicesSchema>;
export const HOST_REMOVAL_SERVICES_BYTES = 256 * 1024;
