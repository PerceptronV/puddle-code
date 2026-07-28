import { z } from 'zod';

/**
 * POST /agent-signal (SPEC §4/§6) — the agent-hook status side-channel.
 * Deliberately OUTSIDE /api: the caller is a hook process the agent spawned on
 * the daemon's own host (e.g. Claude Code's Stop/Notification hooks), which
 * has no bearer token. It authenticates with the per-session `nonce` the
 * daemon injected into the agent PTY's environment at spawn — single-purpose,
 * unguessable, dead once the session's PTY exits. `state` maps to the session
 * status: `working` → running, `waiting_input` → waiting_input.
 */
export const agentSignalRequestSchema = z.object({
  nonce: z.string().min(16),
  state: z.enum(['working', 'waiting_input']),
});
export type AgentSignalRequest = z.infer<typeof agentSignalRequestSchema>;
