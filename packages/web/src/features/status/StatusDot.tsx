import type { SessionKind, SessionStatus } from '@puddle/shared';
import { cn } from '../../lib/utils';

/**
 * The signature element (SPEC §12): a dot that ripples concentrically in
 * --status-running while the agent works — the puddle motif — and pulses
 * --status-waiting when input is needed. prefers-reduced-motion (or the
 * client setting) degrades both to a static dot; styles in app.css. Terminal
 * sessions ripple in blue (--status-terminal) instead of the agent amber.
 */
export function StatusDot({
  status,
  kind = 'agent',
  stale = false,
  className,
}: {
  status: SessionStatus;
  kind?: SessionKind;
  /** `stale_running` (SPEC §4): running, but the agent has been quiet for over an hour. */
  stale?: boolean;
  className?: string;
}) {
  const label = `${kind === 'terminal' ? 'terminal ' : ''}status: ${status.replace('_', ' ')}${
    stale ? ' (no agent activity for over an hour — possibly stalled)' : ''
  }`;
  return (
    <span
      className={cn('status-dot', className)}
      data-status={status}
      data-kind={kind}
      data-stale={stale || undefined}
      role="img"
      title={stale ? 'No agent activity for over an hour — possibly stalled' : undefined}
      aria-label={label}
    />
  );
}
