import { useState } from 'react';
import { Link } from 'react-router';
import {
  Archive,
  Bot,
  ChevronRight,
  FolderX,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  ShieldOff,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { Account, Session } from '@puddle/shared';
import { AgentIcon } from '../../components/agent-icon';
import { ContextMenu, ContextMenuTrigger } from '../../components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import { StatusDot } from '../status/StatusDot';
import {
  SessionActionsEllipsis,
  SessionContextMenu,
  SessionContextMenuBody,
  useSessionMenu,
} from './SessionActions';
import { moveWithinGroups } from './session-order';
import { encodeTabTransfer, TAB_MIME } from './tab-transfer';

/**
 * A project's sessions for the sidebar. `name` null → render no header (the
 * single-project view); a name renders a header + divider so the cross-project
 * view reads as grouped-by-project (SPEC §12). `sessions` arrive pre-ordered.
 */
export interface SessionGroup {
  projectId: string;
  name: string | null;
  sessions: Session[];
}

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
          className="flex items-center rounded-md p-1.5 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
        >
          <Icon className="size-4" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Name over branch — the tooltip for a collapsed dot and any hover label. */
function SessionLabel({ session }: { session: Session }) {
  const renderTitle = useSessionTitleRenderer();
  return (
    <span className="flex flex-col">
      <span>{renderTitle(session)}</span>
      <span className="font-mono text-2xs text-fg-muted">{session.branch}</span>
    </span>
  );
}

/**
 * One collapsed-rail status dot: navigates on click (to its own project, so the
 * cross-project rail switches projects too) and right-clicking opens the same
 * lifecycle menu as the expanded row's ellipsis. The context-menu and tooltip
 * triggers both wrap the single `<Link>` (stacked `asChild`).
 */
function CollapsedSessionDot({
  session,
  activeSessionId,
  onPromote,
  onArchived,
}: {
  session: Session;
  activeSessionId: string | null;
  onPromote: (id: string) => void;
  onArchived: (id: string) => void;
}) {
  const { menu, dialogs } = useSessionMenu(session, onArchived);
  const renderTitle = useSessionTitleRenderer();
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Link
              draggable={false}
              aria-current={session.id === activeSessionId ? 'true' : undefined}
              // Single click opens the session's terminal as a preview tab
              // (via navigation); double click pins it, like a file's tab.
              onDoubleClick={() => onPromote(session.id)}
              to={`/project/${session.project_id}/session/${session.id}`}
              className={cn(
                'flex items-center rounded-md p-1.5 transition-colors hover:bg-elevated',
                session.id === activeSessionId && 'bg-elevated',
              )}
            >
              {/* Active session marked with the same bg-elevated fill-shift the
                  expanded list and the navigator's mode icons use — a theme
                  colour, no border, no default-blue ring (HUMANS.md). The
                  narrower ripple reach keeps it inside the slim rail's cell so
                  the scroll container never crops it. */}
              <StatusDot
                status={session.status}
                kind={session.kind}
                className="[--puddle-ripple-scale:2.3]"
              />
              <span className="sr-only">{renderTitle(session)}</span>
            </Link>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent>
          <SessionLabel session={session} />
        </TooltipContent>
      </Tooltip>
      <SessionContextMenuBody menu={menu} />
      {dialogs}
    </ContextMenu>
  );
}

/**
 * The collapsed right sidebar: a slim rail whose expand / new-terminal /
 * new-session controls stay fixed at the top, then one clickable status dot per
 * live session — grouped by project with a divider between groups (SPEC §12).
 * The dots scroll (no visible scrollbar) so a long list still works.
 */
export function CollapsedSessionsRail({
  groups,
  activeSessionId,
  onReorder,
  onPromote,
  onExpand,
  onNewTerminal,
  onNewSession,
  onArchived,
}: {
  groups: SessionGroup[];
  activeSessionId: string | null;
  onReorder: (ids: string[]) => void;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote: (id: string) => void;
  onExpand: () => void;
  onNewTerminal: () => void;
  onNewSession: () => void;
  onArchived: (id: string) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const withDots = groups.filter((g) => g.sessions.length > 0);
  const move = (id: string, before: string) => {
    const next = moveWithinGroups(withDots, id, before);
    if (next) onReorder(next);
  };
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center bg-surface py-1.5">
      <div className="flex flex-col items-center gap-1">
        <IconButton icon={PanelRightOpen} label="Show sessions" onClick={onExpand} />
        <IconButton icon={SquareTerminal} label="New terminal" onClick={onNewTerminal} />
        <IconButton icon={Bot} label="New agent" onClick={onNewSession} />
      </div>
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {withDots.map((group) => (
          // A divider precedes every group (the first one separates dots from
          // the controls above; the rest separate one project from the next).
          <div key={group.projectId} className="flex flex-col items-center gap-1">
            <div className="my-0.5 h-px w-5 shrink-0 bg-border" />
            {group.sessions.map((session) => (
              <div
                key={session.id}
                draggable
                onDragStart={(e) => {
                  // The same drag reorders within the rail AND, dropped on a
                  // tiling pane, opens the session there as a permanent tab.
                  e.dataTransfer.setData(
                    TAB_MIME,
                    encodeTabTransfer({ type: 'terminal', session: session.id }),
                  );
                  setDragging(session.id);
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== session.id) move(dragging, session.id);
                }}
                className={cn('transition-opacity', dragging === session.id && 'opacity-50')}
              >
                <CollapsedSessionDot
                  session={session}
                  activeSessionId={activeSessionId}
                  onPromote={onPromote}
                  onArchived={onArchived}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One expanded-sidebar row: display-name title over branch/account lines. */
function SessionRow({
  session,
  activeSessionId,
  accountLabel,
  onPromote,
  onArchived,
  ellipsis,
}: {
  session: Session;
  activeSessionId: string | null;
  accountLabel: Map<number, string>;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote?: (id: string) => void;
  onArchived: (id: string) => void;
  /** Whether to mount the hover ellipsis (archived rows omit it). */
  ellipsis: boolean;
}) {
  const renderTitle = useSessionTitleRenderer();
  return (
    <SessionContextMenu session={session} onArchived={onArchived}>
      {(menu) => (
        <Link
          // draggable=false: let the <li> own the drag (reorder), not the
          // anchor's native "drag the URL" behaviour. Click still navigates — to
          // its own project, so the cross-project list switches projects too.
          draggable={false}
          // Single click = preview terminal (via navigation); double click
          // pins it, matching the file tree's single/double-click semantics.
          onDoubleClick={onPromote && (() => onPromote(session.id))}
          to={`/project/${session.project_id}/session/${session.id}`}
          className={cn(
            'group flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-elevated',
            session.id === activeSessionId && 'bg-elevated',
          )}
        >
          <StatusDot status={session.status} kind={session.kind} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-sans text-xs text-fg">{renderTitle(session)}</span>
            <span className="flex items-center gap-1 truncate font-mono text-2xs text-fg-muted">
              <GitBranch className="size-3 shrink-0 text-fg-gold" />
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
          {/* Reserves no width until hover, so the title/branch/badges fill the
              row's whole width; on hover it appears and shoves them left. Stays
              shown while its menu is open even if the pointer has left the row. */}
          {ellipsis && (
            <span className="hidden group-hover:inline-flex has-[[data-state=open]]:inline-flex">
              <SessionActionsEllipsis menu={menu} />
            </span>
          )}
        </Link>
      )}
    </SessionContextMenu>
  );
}

/**
 * Session list: a display-font title over the mono branch (git-branch icon) and
 * account (agent-brand icon) lines, live status ripples, badges, lifecycle menu.
 * Sessions are grouped by project (a header per project in the cross-project
 * view); the list scrolls with no visible scrollbar while the controls stay
 * fixed. Archived sessions are not deleted — they collapse into a disclosure at
 * the bottom so they stay reachable (SPEC §4, §12).
 */
export function SessionSidebar({
  groups,
  accounts,
  activeSessionId,
  onReorder,
  onPromote,
  archived,
  onNewSession,
  onNewTerminal,
  onCollapse,
  onArchived,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  activeSessionId: string | null;
  /** Rows drag-reorder within their project group; `ids` is the full visible order. */
  onReorder: (ids: string[]) => void;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote: (id: string) => void;
  /** Current project's archived sessions. */
  archived: Session[];
  onNewSession: () => void;
  onNewTerminal: () => void;
  onCollapse: () => void;
  onArchived: (id: string) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const withSessions = groups.filter((g) => g.sessions.length > 0);
  const total = withSessions.reduce((n, g) => n + g.sessions.length, 0);

  const move = (id: string, before: string) => {
    const next = moveWithinGroups(withSessions, id, before);
    if (next) onReorder(next);
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Fixed controls: collapse on the left edge; new-terminal and new-session
          on the right, mirroring the left navigator's icon row (HUMANS.md). */}
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <IconButton icon={PanelRightClose} label="Hide sessions" onClick={onCollapse} />
        <div className="ml-auto flex items-center gap-1">
          <IconButton icon={SquareTerminal} label="New terminal" onClick={onNewTerminal} />
          <IconButton icon={Bot} label="New agent" onClick={onNewSession} />
        </div>
      </div>
      {/* No horizontal padding: the active/hover fill-shift bleeds to both
          sidebar edges (each row carries its own px-3). Scrolls without a
          visible scrollbar so a long cross-project list still works. */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-1.5">
        {total === 0 && archived.length === 0 && (
          <p className="px-3 py-3 text-xs text-fg-muted">
            No sessions yet — press ⌘K to start one.
          </p>
        )}
        {withSessions.map((group) => (
          <div key={group.projectId}>
            {group.name !== null && (
              <div className="truncate px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-fg-gold">
                {group.name}
              </div>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.sessions.map((session) => (
                <li
                  key={session.id}
                  draggable
                  onDragStart={(e) => {
                    // Reorders within the list AND, dropped on a tiling pane,
                    // opens the session there as a permanent tab.
                    e.dataTransfer.setData(
                      TAB_MIME,
                      encodeTabTransfer({ type: 'terminal', session: session.id }),
                    );
                    setDragging(session.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragging && dragging !== session.id) move(dragging, session.id);
                  }}
                  className={cn('transition-opacity', dragging === session.id && 'opacity-50')}
                >
                  <SessionRow
                    session={session}
                    activeSessionId={activeSessionId}
                    accountLabel={accountLabel}
                    onPromote={onPromote}
                    onArchived={onArchived}
                    ellipsis
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {/* Archived sessions: hidden by default under a collapsible header at the
          bottom, never deleted — click one to reopen it and read its history
          (SPEC §4). */}
      {archived.length > 0 && (
        <div className="shrink-0 pb-1.5">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-2xs uppercase tracking-wide text-fg-gold transition-colors hover:text-fg"
          >
            <ChevronRight
              className={cn('size-3 transition-transform', showArchived && 'rotate-90')}
            />
            <Archive className="size-3" />
            <span>Archived</span>
            <span className="ml-auto tabular-nums">{archived.length}</span>
          </button>
          {showArchived && (
            <ul className="no-scrollbar flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {archived.map((session) => (
                <li key={session.id}>
                  <SessionRow
                    session={session}
                    activeSessionId={activeSessionId}
                    accountLabel={accountLabel}
                    onArchived={onArchived}
                    ellipsis
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
