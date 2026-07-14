import { Link } from 'react-router';
import { FolderX, Plus, ShieldOff, UserRound } from 'lucide-react';
import type { Account, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { StatusDot } from '../status/StatusDot';
import { SessionActions } from './SessionActions';

/** Session list: mono identity, live status ripples, badges, lifecycle menu. */
export function SessionSidebar({
  projectId,
  sessions,
  accounts,
  activeSessionId,
  onNewSession,
  onArchived,
}: {
  projectId: string;
  sessions: Session[];
  accounts: Account[];
  activeSessionId: string | null;
  onNewSession: () => void;
  onArchived: (id: string) => void;
}) {
  const visible = sessions.filter((s) => s.status !== 'archived');
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 py-2 pl-5 pr-3">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">Sessions</span>
        <Button variant="ghost" size="icon" className="ml-auto size-6" onClick={onNewSession}>
          <Plus />
          <span className="sr-only">New session</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {visible.length === 0 && (
          // pl-3.5 stacks on the container's p-1.5 → flush with the pl-5 header.
          <p className="py-3 pl-3.5 pr-1.5 text-xs text-fg-muted">
            No sessions yet — press ⌘K to start one.
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {visible.map((session) => (
            <li key={session.id}>
              <Link
                to={`/project/${projectId}/session/${session.id}`}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-elevated',
                  session.id === activeSessionId && 'bg-elevated',
                )}
              >
                <StatusDot status={session.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-fg">
                    {session.title ?? session.id.slice(0, 8)}
                  </span>
                  <span className="block truncate font-mono text-2xs text-fg-muted">
                    {session.branch}
                  </span>
                  {accountLabel.has(session.account_id) && (
                    <span className="flex items-center gap-1 truncate font-mono text-2xs text-fg-muted">
                      <UserRound className="size-3 shrink-0" />
                      <span className="truncate">{accountLabel.get(session.account_id)}</span>
                    </span>
                  )}
                </span>
                {session.skip_permissions && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <ShieldOff className="size-3.5 shrink-0 text-waiting" />
                    </TooltipTrigger>
                    <TooltipContent>Running with permission prompts skipped</TooltipContent>
                  </Tooltip>
                )}
                {session.worktree_missing && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <FolderX className="size-3.5 shrink-0 text-interrupted" />
                    </TooltipTrigger>
                    <TooltipContent>Worktree directory is gone — archive only</TooltipContent>
                  </Tooltip>
                )}
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <SessionActions session={session} onArchived={onArchived} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
