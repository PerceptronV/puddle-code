import { z } from 'zod';
import { hostStageRecordSchema } from '../../installation/stage.js';

/** Host-private manager inspection only; never part of encrypted profile administration. */
export const connectorInspectionRequestSchema = z
  .object({ t: z.literal('inspect'), nonce: z.uuid() })
  .strict();
export const connectorInspectionResponseSchema = z
  .object({
    t: z.literal('inspection'),
    nonce: z.uuid(),
    instance: z.uuid(),
    ready: z.boolean(),
    pid: z.number().int().positive().safe(),
    version: z.string().min(1).max(128),
    application: hostStageRecordSchema.shape.protocol,
    remote: z.number().int().nonnegative().safe(),
    node_path: z.string().min(1).max(4096),
    entry_path: z.string().min(1).max(4096),
    release_path: z.string().min(1).max(4096),
  })
  .strip();
export type ConnectorInspectionResponse = z.infer<typeof connectorInspectionResponseSchema>;
