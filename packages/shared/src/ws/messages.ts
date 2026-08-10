import { z } from 'zod';
import type { SessionStatus } from '../api/sessions.js';

/** Terminal ids within a stream: the agent PTY or numbered shells. */
export const termId = z.string().regex(/^(agent|shell-[0-9]+)$/);

/**
 * The homescreen's project-less PTY stream: one shell in the daemon host's
 * home directory, for cloning repositories before they become projects
 * (SPEC §11). `spawn-shell` on this stream reuses the live shell when one
 * exists rather than spawning a second.
 */
export const HOME_STREAM = 'home';

const dims = {
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
};

/**
 * `session` addresses a PTY stream: a puddle session uuid, `login-<accountId>`
 * for account-login PTYs (which attach "like a session", SPEC §6), or `home`
 * (HOME_STREAM) for the homescreen shell.
 */
export const wsClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string() }),
  z.object({ t: z.literal('attach'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('stdin'), session: z.string(), term: termId, data: z.string() }),
  z.object({ t: z.literal('resize'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('detach'), session: z.string(), term: termId }),
  z.object({ t: z.literal('spawn-shell'), session: z.string() }),
  /** Terminate a shell PTY (never the agent term); viewers learn via `exit`. */
  z.object({ t: z.literal('kill-shell'), session: z.string(), term: termId }),
  z.object({ t: z.literal('subscribe-status') }),
  /**
   * The client's resolved terminal colours (14.1): the DAEMON answers agents'
   * OSC 10/11 dynamic-colour queries from the last pair any client reported —
   * an auto-theming agent (e.g. Claude Code) queries at spawn, usually before
   * a viewer has attached, so a viewer-side answer misses it and the agent
   * falls back to dark whatever the app's theme. Sent after auth on every
   * connect and again on theme switches.
   */
  z.object({
    t: z.literal('theme'),
    fg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export type WsServerMessage =
  | { t: 'shell-spawned'; session: string; term: string }
  | { t: 'replay'; session: string; term: string; data: string }
  | { t: 'output'; session: string; term: string; data: string }
  | { t: 'status'; session: string; status: SessionStatus; last_activity_at: string | null }
  | {
      t: 'renamed';
      session: string;
      title: string | null;
      agent_title?: string | null;
      osc_title?: string | null;
    }
  | { t: 'exit'; session: string; term: string; code: number }
  /**
   * Something went wrong that the user must SEE, not just something a log
   * records. Broadcast to every status subscriber rather than only to a client
   * attached to the stream, because the whole point is to reach someone whose
   * tab is elsewhere. The UI surfaces these as toasts.
   *
   * `detail` is the tail of whatever the process printed — for a failed launch
   * that is the agent's own error text, which is usually the entire diagnosis.
   */
  | {
      t: 'notice';
      level: 'error' | 'warning';
      title: string;
      detail?: string;
      session?: string;
      term?: string;
    }
  /**
   * An account's `logged_in` flag changed (protocol 15.1). Broadcast to every
   * status subscriber: the daemon only records the flag after the adapter's
   * own auth check answers — after the login dialog has already closed — so
   * this push is what turns the accounts UI green without a reload. Older
   * clients drop the unknown `t` per PROTOCOL.md wire rule 1.
   */
  | { t: 'account'; account_id: number; profile_id: string; logged_in: boolean }
  | { t: 'error'; message: string };
