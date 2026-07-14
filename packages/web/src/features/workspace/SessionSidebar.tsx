import { useState } from 'react';
import { Link } from 'react-router';
import {
  FolderX,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  ShieldOff,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { Account, Session } from '@puddle/shared';
import { AgentIcon } from '../../components/agent-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { StatusDot } from '../status/StatusDot';
import { SessionActions } from './SessionActions';
import { orderSessions, reorderIds } from './session-order';

/** A borderless icon button with a fill-shift hover (mirrors the left navigator). */
function IconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
        >
          <Icon className="size-4" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The collapsed right sidebar: a slim rail holding the expand / new-terminal /
 * new-session controls, then a divider and one clickable status dot per live
 * session so you can switch sessions without reopening the sidebar (HUMANS.md
 * minimalism — no border, fill-shift hover). Mirrors the left navigator's
 * `CollapsedSidebarRail`.
 */
export function CollapsedSessionsRail({
  projectId,
  sessions,
  activeSessionId,
  order,
  onReorder,
  onExpand,
  onNewTerminal,
  onNewSession,
}: {
  projectId: string;
  sessions: Session[];
  activeSessionId: string | null;
  /** Persisted user order — must match the expanded sidebar's order exactly. */
  order: string[];
  onReorder: (ids: string[]) => void;
  onExpand: () => void;
  onNewTerminal: () => void;
  onNewSession: () => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  // Same ordering as the expanded sidebar so the dots line up, and drag-
  // reorderable the same way.
  const visible = orderSessions(
    sessions.filter((s) => s.status !== 'archived'),
    order,
  );
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
    <div className="flex h-full w-9 shrink-0 flex-col items-center bg-surface py-1.5">
      <div className="flex flex-col items-center gap-1">
        <IconButton icon={PanelRightOpen} label="Show sessions" onClick={onExpand} />
        <IconButton icon={SquareTerminal} label="New terminal" onClick={onNewTerminal} />
        <IconButton icon={Plus} label="New session" onClick={onNewSession} />
      </div>
      {visible.length > 0 && <div className="my-1.5 h-px w-5 shrink-0 bg-border" />}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {visible.map((session) => (
          <div
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  draggable={false}
                  aria-current={session.id === activeSessionId ? 'true' : undefined}
                  to={`/project/${projectId}/session/${session.id}`}
                  className={cn(
                    'flex items-center rounded-md p-1.5 transition-colors hover:bg-elevated',
                    session.id === activeSessionId && 'bg-elevated',
                  )}
                >
                  {/* Active session marked with the same bg-elevated fill-shift
                      the expanded list and the navigator's mode icons use — a
                      theme colour, no border, no default-blue ring (HUMANS.md). */}
                  <StatusDot status={session.status} kind={session.kind} />
                  <span className="sr-only">{session.title ?? session.branch}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent>{session.title ?? session.branch}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Session list: a display-font title over the mono branch (git-branch icon) and
 * account (agent-brand icon) lines, live status ripples, badges, lifecycle menu.
 */
export function SessionSidebar({
  projectId,
  sessions,
  accounts,
  activeSessionId,
  order,
  onReorder,
  onNewSession,
  onNewTerminal,
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
  onNewTerminal: () => void;
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
      {/* Collapse on the left edge; new-terminal and new-session on the right,
          mirroring the left navigator's icon row (HUMANS.md). */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <IconButton icon={PanelRightClose} label="Hide sessions" onClick={onCollapse} />
        <div className="ml-auto flex items-center gap-1">
          <IconButton icon={SquareTerminal} label="New terminal" onClick={onNewTerminal} />
          <IconButton icon={Plus} label="New session" onClick={onNewSession} />
        </div>
      </div>
      {/* No horizontal padding: the active/hover fill-shift bleeds to both
          sidebar edges (each row carries its own px-3). */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {visible.length === 0 && (
          <p className="px-3 py-3 text-xs text-fg-muted">
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
                  'group flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-elevated',
                  session.id === activeSessionId && 'bg-elevated',
                )}
              >
                <StatusDot status={session.status} kind={session.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-xs text-fg">
                    {session.title ?? session.id.slice(0, 8)}
                  </span>
                  <span className="flex items-center gap-1 truncate font-mono text-2xs text-fg-muted">
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate">{session.branch}</span>
                  </span>
                  {/* Terminal sessions have no account, so this line is agent-only. */}
                  {session.account_id !== null && accountLabel.has(session.account_id) && (
                    <span className="flex items-center gap-1 truncate font-mono text-2xs text-fg-muted">
                      <AgentIcon type={session.agent_type ?? ''} className="size-3 shrink-0" />
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
                {/* Reserves no width until hover, so the title/branch/badges
                    fill the row's whole width; on hover it appears and shoves
                    them left. Stays shown while its menu is open even if the
                    pointer has left the row. */}
                <span className="hidden group-hover:inline-flex has-[[data-state=open]]:inline-flex">
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
