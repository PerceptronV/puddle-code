import type { SessionStatus } from '@puddle/shared';
import { cn } from '../../lib/utils';

/**
 * The signature element (SPEC §12): a dot that ripples concentrically in
 * --status-running while the agent works — the puddle motif — and pulses
 * --status-waiting when input is needed. prefers-reduced-motion (or the
 * client setting) degrades both to a static dot; styles in app.css.
 */
export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <span
      className={cn('status-dot', className)}
      data-status={status}
      role="img"
      aria-label={`status: ${status.replace('_', ' ')}`}
    />
  );
}
