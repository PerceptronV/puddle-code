import { useState } from 'react';
import { Link } from 'react-router';
import { FolderX, PanelRightClose, PanelRightOpen, Plus, ShieldOff, UserRound } from 'lucide-react';
import type { Account, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { StatusDot } from '../status/StatusDot';
import { SessionActions } from './SessionActions';
import { orderSessions, reorderIds } from './session-order';

/**
 * The collapsed right sidebar: a slim rail holding just the expand control and
 * the new-session button, mirroring the left navigator's `CollapsedSidebarRail`
 * (HUMANS.md minimalism — no border, fill-shift hover).
 */
export function CollapsedSessionsRail({
  onExpand,
  onNewSession,
}: {
  onExpand: () => void;
  onNewSession: () => void;
}) {
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center gap-1 bg-surface py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onExpand}
            className="flex items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <PanelRightOpen className="size-4" />
            <span className="sr-only">Show sessions</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Show sessions</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onNewSession}
            className="flex items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <Plus className="size-4" />
            <span className="sr-only">New session</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>New session</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Session list: mono identity, live status ripples, badges, lifecycle menu. */
export function SessionSidebar({
  projectId,
  sessions,
  accounts,
  activeSessionId,
  order,
  onReorder,
  onNewSession,
  onCollapse,
  onArchived,
}: {
  projectId: string;
  sessions: Session[];
  accounts: Account[];
  activeSessionId: string | null;
  /** Persisted user order (session ids); sessions absent from it sort to the top. */
  order: string[];
  onReorder: (ids: string[]) => void;
  onNewSession: () => void;
  onCollapse: () => void;
  onArchived: (id: string) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  // The list is drag-reorderable; new sessions appear on top until dragged
  // (SPEC §8). Order keys on session id, so any session type orders the same.
  const visible = orderSessions(
    sessions.filter((s) => s.status !== 'archived'),
    order,
  );
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));

  // Persist the FULL current order (visible ids with `id` moved before
  // `before`), so previously-untracked sessions become tracked in one go.
  const move = (id: string, before: string) => {
    if (id === before) return;
    onReorder(
      reorderIds(
        visible.map((s) => s.id),
        id,
        before,
      ),
    );
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Controls sit on the left edge (nearest the content they affect);
          the title balances them on the right. */}
      <div className="flex items-center gap-1 py-2 pl-3 pr-5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-6" onClick={onCollapse}>
              <PanelRightClose />
              <span className="sr-only">Hide sessions</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hide sessions</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" className="size-6" onClick={onNewSession}>
          <Plus />
          <span className="sr-only">New session</span>
        </Button>
        <span className="ml-auto text-2xs font-medium uppercase tracking-wide text-fg-muted">
          Sessions
        </span>
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
            <li
              key={session.id}
              draggable
              onDragStart={() => setDragging(session.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragging && dragging !== session.id) move(dragging, session.id);
              }}
              className={cn('transition-opacity', dragging === session.id && 'opacity-50')}
            >
              <Link
                // draggable=false: let the <li> own the drag (reorder), not the
                // anchor's native "drag the URL" behaviour. Click still navigates.
                draggable={false}
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
