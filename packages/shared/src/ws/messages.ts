import { z } from 'zod';
import type { SessionStatus } from '../api/sessions.js';

/** Terminal ids within a stream: the agent PTY or numbered shells. */
export const termId = z.string().regex(/^(agent|shell-[0-9]+)$/);

const dims = {
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
};

/**
 * `session` addresses a PTY stream: a puddle session uuid, or `login-<accountId>`
 * for account-login PTYs (which attach "like a session", SPEC §6).
 */
export const wsClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string() }),
  z.object({ t: z.literal('attach'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('stdin'), session: z.string(), term: termId, data: z.string() }),
  z.object({ t: z.literal('resize'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('detach'), session: z.string(), term: termId }),
  z.object({ t: z.literal('spawn-shell'), session: z.string() }),
  z.object({ t: z.literal('subscribe-status') }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export type WsServerMessage =
  | { t: 'shell-spawned'; session: string; term: string }
  | { t: 'replay'; session: string; term: string; data: string }
  | { t: 'output'; session: string; term: string; data: string }
  | { t: 'status'; session: string; status: SessionStatus; last_activity_at: string | null }
  | { t: 'renamed'; session: string; title: string | null; agent_title?: string | null }
  | { t: 'exit'; session: string; term: string; code: number }
  | { t: 'error'; message: string };
