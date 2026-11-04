import { z } from 'zod';
import {
  cockpitHostUpdateReplySchema,
  cockpitHostUpdateStatusSchema,
  onlineHostUpdateRequestSchema,
} from './cockpit-updates.js';

/** Private host control: only bounded, public update inputs; never stage receipts or paths. */
export const hostMaintenanceCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), id: z.uuid().optional() }).strict(),
  ...onlineHostUpdateRequestSchema.options,
]);
export const hostMaintenanceReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), status: cockpitHostUpdateStatusSchema }).strict(),
  z.object({ kind: z.literal('result'), result: cockpitHostUpdateReplySchema }).strict(),
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
