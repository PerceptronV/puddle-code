import { z } from 'zod';
import { isoTimestamp } from './common.js';

/**
 * GET /api/sessions/:id/ports (SPEC §9) — listening TCP ports detected within
 * the session's process tree (the agent plus every live shell terminal on its
 * stream, and their descendants). Detection is scoped per-session: a port
 * bound by an unrelated process on the host never appears here.
 */
export const sessionPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int(),
  /** Process name (comm) owning the listener, e.g. "node". */
  command: z.string(),
  /** Bound address as reported by the OS, e.g. "127.0.0.1", "*", "::". */
  address: z.string(),
});
export type SessionPort = z.infer<typeof sessionPortSchema>;

export const sessionPortsResponseSchema = z.object({
  ports: z.array(sessionPortSchema),
  scanned_at: isoTimestamp,
});
export type SessionPortsResponse = z.infer<typeof sessionPortsResponseSchema>;
