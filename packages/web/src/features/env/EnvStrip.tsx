import type { Session } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useSessionEnv } from '../../lib/queries';

const LIVE_STATUSES: Session['status'][] = ['running', 'waiting_input'];

/**
 * Slim mono row of the session's captured env var NAMES (SPEC §4) — values are
 * secrets and never leave the daemon — rendered IN FLOW below the pane body
 * beside the ports strip (PaneLeaf), never an overlay. Hidden entirely when
 * the session isn't live or nothing is captured; no refresh control, the
 * hook's 5s poll is the refresh (HUMANS.md minimalism). Clearing lives in the
 * session menu, not here.
 */
export function EnvStrip({ sessionId, status }: { sessionId: string; status: Session['status'] }) {
  const live = LIVE_STATUSES.includes(status);
  const { data } = useSessionEnv(sessionId, live);
  const vars = data?.vars ?? [];

  if (!live || vars.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1 font-mono text-xs">
      <span className="text-fg-muted">env</span>
      <div className="flex flex-wrap items-center gap-1">
        {vars.map((v) => (
          <Tooltip key={v.name}>
            <TooltipTrigger asChild>
              <span className="cursor-default rounded px-1.5 py-0.5 text-fg-secondary transition-colors hover:bg-elevated hover:text-fg">
                {v.name}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {v.bytes} B · captured from this session&apos;s shell — re-injected into new shells
              and agent restarts
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
