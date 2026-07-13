import { z } from 'zod';
import { isoTimestamp, rowId } from './common.js';
import { fsSafeName } from './profiles.js';

export const accountSchema = z.object({
  id: rowId,
  profile_id: rowId,
  agent_type: z.string(),
  label: z.string(),
  config_dir: z.string(),
  skip_permissions_default: z.boolean(),
  logged_in: z.boolean(),
  created_at: isoTimestamp,
});
export type Account = z.infer<typeof accountSchema>;

export const createAccountRequestSchema = z.object({
  profile_id: rowId,
  agent_type: z.string().min(1),
  label: fsSafeName,
  skip_permissions_default: z.boolean().optional(),
});

/** Returned by POST /api/accounts/:id/login — attach to this PTY over the WS. */
export const loginResponseSchema = z.object({ stream: z.string(), term: z.string() });
export type LoginResponse = z.infer<typeof loginResponseSchema>;
