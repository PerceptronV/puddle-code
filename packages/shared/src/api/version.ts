import { z } from 'zod';

/** App version plus the protocol handshake (SPEC §6; bump rules in PROTOCOL.md). */
export const versionResponseSchema = z.object({
  version: z.string(),
  /** Added by the host connector; absent on direct daemon responses and older connectors. */
  remote_image_uploads: z.boolean().optional(),
  protocol: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }),
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;
