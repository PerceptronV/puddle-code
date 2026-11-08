import { z } from 'zod';
import {
  frontendHostUpdateReplySchema,
  frontendHostUpdateStatusSchema,
  onlineHostUpdateRequestSchema,
} from './frontend-updates.js';

/** Private host control: only bounded, public update inputs; never stage receipts or paths. */
export const hostMaintenanceCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('status'),
      id: z.uuid().optional(),
      include_component_releases: z.literal(true).optional(),
    })
    .strict(),
  ...onlineHostUpdateRequestSchema.options,
]);
export const hostMaintenanceReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), status: frontendHostUpdateStatusSchema }).strict(),
  z.object({ kind: z.literal('result'), result: frontendHostUpdateReplySchema }).strict(),
]);
export const hostMaintenanceControlRequestSchema = z
  .object({
    t: z.literal('host-maintenance'),
    request_id: z.uuid(),
    command: hostMaintenanceCommandSchema,
  })
  .strict();
export const hostMaintenanceControlResponseSchema = z
  .object({
    t: z.literal('host-maintenance-result'),
    request_id: z.uuid(),
    result: hostMaintenanceReplySchema,
  })
  .strict();
export type HostMaintenanceCommand = z.infer<typeof hostMaintenanceCommandSchema>;
export type HostMaintenanceReply = z.infer<typeof hostMaintenanceReplySchema>;
