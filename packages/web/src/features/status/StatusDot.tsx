import type { SessionKind, SessionStatus } from '@puddle/shared';
import { cn } from '../../lib/utils';

/**
 * The signature element (SPEC §12): a dot that ripples concentrically in
 * --status-running while the agent works — the puddle motif — and pulses
 * --status-waiting when input is needed. prefers-reduced-motion (or the
 * client setting) degrades both to a static dot; styles in app.css. Terminal
 * sessions ripple in blue (--status-terminal) instead of the agent green.
 */
export function StatusDot({
  status,
  kind = 'agent',
  className,
}: {
  status: SessionStatus;
  kind?: SessionKind;
  className?: string;
}) {
  return (
    <span
      className={cn('status-dot', className)}
      data-status={status}
      data-kind={kind}
      role="img"
      aria-label={`${kind === 'terminal' ? 'terminal ' : ''}status: ${status.replace('_', ' ')}`}
    />
  );
}
