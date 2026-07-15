import type { Session } from '@puddle/shared';

/**
 * A session's display name: the user's rename override if set, else the agent's
 * own session name (for Claude Code, its transcript title), else the leading
 * block of the session id. Mirrors the daemon's precedence (SPEC §4).
 */
export function sessionDisplayName(session: Pick<Session, 'id' | 'title' | 'agent_title'>): string {
  return session.title ?? session.agent_title ?? session.id.slice(0, 8);
}
