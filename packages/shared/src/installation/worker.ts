import { z } from 'zod';
import { hostServiceReplacementSchema } from './supervision.js';
import { hostConnectorReplacementSchema } from './connector.js';
import { runtimeControllerSchema } from '../runtime/storage.js';

/** Private pinned one-shot job; never accepted from a browser as a command. */
export const hostUpdateWorkerSchema = z
  .object({
    format: z.literal(1),
    operation_id: z.uuid(),
    dispatch_id: z.uuid(),
    dispatch_revision: z.number().int().positive().safe(),
    preflight: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(['systemd', 'launchd']),
    name: z.string().min(1).max(128),
    domain: z
      .string()
      .regex(/^gui\/\d+$/)
      .nullable(),
    release_path: z.string().min(1).max(4096),
    node_path: z.string().min(1).max(4096),
    entry_path: z.string().min(1).max(4096),
    installer_path: z.string().min(1).max(4096),
    state: z.enum(['dispatching', 'dispatched']),
    daemon_service: hostServiceReplacementSchema.optional(),
    connector: hostConnectorReplacementSchema.optional(),
    /** Explicit consent, bound to the same release and impact as preflight. */
    interruption_approval: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** Only this outgoing daemon may publish the worker's shutdown checkpoint. */
    outgoing: z
      .object({
        pid: z.number().int().positive().safe(),
        controller: runtimeControllerSchema.pick({ id: true, epoch: true }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (record) =>
      !record.interruption_approval ||
      (!!record.outgoing &&
        !!record.daemon_service &&
        record.interruption_approval === record.preflight),
    'Interruption approval does not match the daemon update',
  );
export type HostUpdateWorker = z.infer<typeof hostUpdateWorkerSchema>;

/** Private evidence written before activation, while the worker owns its execution claim. */
export const hostUpdateWorkerLifetimeSchema = z
  .object({
    format: z.literal(1),
    operation_id: z.uuid(),
    dispatch_id: z.uuid(),
    worker_id: z.uuid(),
    preflight: z.string().regex(/^[0-9a-f]{64}$/),
    /** The worker must lead this group; its commands are never detached from it. */
    process_group: z
      .number()
      .int()
      .positive()
      .max(2 ** 31 - 1),
  })
  .strict();
export type HostUpdateWorkerLifetime = z.infer<typeof hostUpdateWorkerLifetimeSchema>;

/** In-process final approval evidence copied into the private pinned job. */
export type HostUpdateDaemonHandoff = Required<
  Pick<HostUpdateWorker, 'outgoing' | 'daemon_service' | 'connector'>
> &
  Pick<HostUpdateWorker, 'interruption_approval'>;
