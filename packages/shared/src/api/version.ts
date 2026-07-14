import { z } from 'zod';

/** App version plus the protocol handshake (SPEC §6; bump rules in PROTOCOL.md). */
export const versionResponseSchema = z.object({
  version: z.string(),
  protocol: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }),
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;
