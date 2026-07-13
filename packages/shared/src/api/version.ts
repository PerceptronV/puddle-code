import { z } from 'zod';

export const versionResponseSchema = z.object({ version: z.string() });
export type VersionResponse = z.infer<typeof versionResponseSchema>;
