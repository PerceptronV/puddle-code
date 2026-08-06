import { SquareTerminal } from 'lucide-react';
import type { SessionKind, SessionStatus } from '@puddle/shared';
import { AgentIcon } from '../../components/agent-icon';
import { cn } from '../../lib/utils';

/**
 * One glyph carrying BOTH facts a session row needs: which agent is driving it,
 * and what that session is doing. The agent's own brand mark (a terminal glyph
 * for a shell session) rendered in the status colour — one glyph instead of two,
 * where a dot beside an icon said the same thing twice. Static: colour alone
 * carries the state (SPEC §12).
 *
 * This is now the only status indicator: the collapsed rail was the last place
 * a bare dot survived, and it shows the mark too (2026-08-03).
 */
export function SessionGlyph({
  status,
  kind = 'agent',
  agentType,
  stale = false,
  className,
  iconClassName = 'size-3',
}: {
  status: SessionStatus;
  kind?: SessionKind;
  /** Null/absent for terminals, which show a terminal glyph instead. */
  agentType?: string | null;
  /** `stale_running` (SPEC §4): running, but the agent has been quiet for over an hour. */
  stale?: boolean;
  className?: string;
  /**
   * The mark itself, inside the `className`-sized box. The 12px default suits
   * inline rows; the collapsed rail passes `size-full` so the mark fills its
   * chip (the glyph IS the row there — decision 2026-08-06).
   */
  iconClassName?: string;
}) {
  const what = kind === 'terminal' ? 'terminal' : (agentType ?? 'agent');
  const label = `${what} — status: ${status.replace('_', ' ')}${
    stale ? ' (no agent activity for over an hour — possibly stalled)' : ''
  }`;
  return (
    <span
      className={cn('status-glyph', className)}
      data-status={status}
      data-kind={kind}
      data-stale={stale || undefined}
      role="img"
      title={stale ? 'No agent activity for over an hour — possibly stalled' : undefined}
      aria-label={label}
    >
      {kind === 'terminal' ? (
        <SquareTerminal className={iconClassName} />
      ) : (
        <AgentIcon type={agentType ?? ''} className={iconClassName} />
      )}
    </span>
  );
}
