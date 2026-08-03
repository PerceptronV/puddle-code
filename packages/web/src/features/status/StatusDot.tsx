import type { SessionKind, SessionStatus } from '@puddle/shared';
import { cn } from '../../lib/utils';

/**
 * A session's status as a small dot in the status colour (SPEC §12): amber
 * running, green waiting, ember interrupted, blue for a terminal, grey idle,
 * faded when stale. Static — the ripple and pulse were removed (2026-08-03);
 * styles in app.css.
 *
 * Used where there is no room for the agent's brand mark: the collapsed session
 * rail. Rows and tab chips use `SessionGlyph`, which is the mark itself in the
 * same colours.
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
