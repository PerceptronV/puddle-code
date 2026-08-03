import { SquareTerminal } from 'lucide-react';
import type { SessionKind, SessionStatus } from '@puddle/shared';
import { AgentIcon } from '../../components/agent-icon';
import { cn } from '../../lib/utils';

/**
 * One glyph carrying BOTH facts a session row needs: which agent is driving it,
 * and what that session is doing. The agent's own brand mark (a terminal glyph
 * for a shell session) rendered in the status colour, rippling and pulsing
 * exactly as the status dot does — it keeps SPEC §12's motif while spending one
 * glyph instead of two. A dot beside an icon said the same thing twice.
 *
 * The dot itself (`StatusDot`) survives where there is no room for a mark and
 * nothing to deduplicate: the collapsed session rail.
 */
export function SessionGlyph({
  status,
  kind = 'agent',
  agentType,
  stale = false,
  className,
}: {
  status: SessionStatus;
  kind?: SessionKind;
  /** Null/absent for terminals, which show a terminal glyph instead. */
  agentType?: string | null;
  /** `stale_running` (SPEC §4): running, but the agent has been quiet for over an hour. */
  stale?: boolean;
  className?: string;
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
        <SquareTerminal className="size-3" />
      ) : (
        <AgentIcon type={agentType ?? ''} className="size-3" />
      )}
    </span>
  );
}
