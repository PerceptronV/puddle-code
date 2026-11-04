import { z } from 'zod';
import { hostServiceReplacementSchema } from './supervision.js';
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
    /** Only this outgoing daemon may publish the worker's shutdown checkpoint. */
    outgoing: z
      .object({
        pid: z.number().int().positive().safe(),
        controller: runtimeControllerSchema.pick({ id: true, epoch: true }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HostUpdateWorker = z.infer<typeof hostUpdateWorkerSchema>;
