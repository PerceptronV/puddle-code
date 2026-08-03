import { useState, type ReactNode } from 'react';
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { toastError } from '../../lib/errors';
import { ABBREV_MAX, normaliseAbbrev } from '../../lib/project-abbrev';
import { usePatchProject } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import { SessionGlyph } from '../status/SessionGlyph';
import {
  SessionActionsEllipsis,
  SessionContextMenu,
  SessionContextMenuBody,
  useSessionMenu,
} from './SessionActions';
import { moveWithinGroups } from './session-order';
import { encodeTabTransfer, TAB_MIME } from './tab-transfer';

/**
 * A project's sessions for the sidebar. Groups are retained even when empty so
 * the project itself remains a navigation target (SPEC §12).
 */
export interface SessionGroup {
  projectId: string;
  name: string;
  /** The collapsed rail's ≤5-char label (stored abbrev, else derived — SPEC §12). */
  abbrev: string;
  /** The project's repository — seeds the create dialogue for "new … in project". */
  repoId: number;
  sessions: Session[];
}

/** Callbacks every project header carries (context menu + drag reorder). */
export interface ProjectHeaderActions {
  /** Open the new-agent dialogue targeting this project. */
  onNewSessionIn: (projectId: string) => void;
  /** Open the new-terminal dialogue targeting this project. */
  onNewTerminalIn: (projectId: string) => void;
  /** A project-header drag: move `dragId` before `beforeId` in `projectOrder`. */
  onMoveProject: (dragId: string, beforeId: string) => void;
}

/**
 * A project-name drag reorders projects; its payload is this private MIME so no
 * pane or list mistakes it for a tab drag (reordering rides dragover, the
 * payload itself is never dropped anywhere).
 */
const PROJECT_MIME = 'application/x-puddle-project';

/**
 * The project name's right-click menu: start a new agent or terminal IN that
 * project — the same create dialogue the sidebar's fixed controls open, seeded
 * with this project instead of the current one.
 */
function ProjectMenuBody({
  projectId,
  actions,
}: {
  projectId: string;
  actions: ProjectHeaderActions;
}) {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => actions.onNewSessionIn(projectId)}>
        <Bot />
        New agent
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.onNewTerminalIn(projectId)}>
        <SquareTerminal />
        New terminal
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/**
 * Inline label editor for the ACTIVE project's name (expanded header) or
 * abbreviation (collapsed rail): commit on Enter or blur, Esc cancels.
 * Keystrokes stay here — the global hotkey dispatcher must not see them.
 */
function InlineLabelEdit({
  initial,
  maxLength,
  className,
  onCommit,
  onCancel,
}: {
  initial: string;
  maxLength?: number;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      maxLength={maxLength}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit(value);
        else if (e.key === 'Escape') onCancel();
      }}
      className={cn('bg-transparent outline-none', className)}
    />
  );
}

/**
 * While any project name is being dragged, every group's session list collapses
 * (0fr grid row) so the list reads as just the project names — the dragged name
 * repositions against its neighbours, exactly like a homescreen card.
 */
function CollapsibleSessions({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200',
        collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A borderless icon button with a fill-shift hover (mirrors the left navigator).
 * `active` marks a toggled-on state with the same `bg-elevated` fill the nav
 * mode icons use (for the Scratchpad view toggle).
 */
function IconButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  tooltipSide,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** The collapsed rail opens its tooltips inward (left), like the left rail. */
  tooltipSide?: 'left';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          className={cn(
            'flex items-center rounded-md p-1.5 transition-colors',
            active ? 'bg-elevated text-fg' : 'text-fg-gold hover:bg-elevated hover:text-fg',
          )}
        >
          <Icon className="size-4" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Name over branch over agent · account — the tooltip for a collapsed dot. */
function SessionLabel({ session, accountLabel }: { session: Session; accountLabel?: string }) {
  const renderTitle = useSessionTitleRenderer();
  return (
    <span className="flex flex-col">
      <span>{renderTitle(session)}</span>
      <span className="font-mono text-2xs text-fg-muted">{session.branch}</span>
      <span className="mt-0.5 flex items-center gap-1 font-mono text-2xs text-fg-muted">
        {session.kind === 'terminal' ? (
          <>
            <SquareTerminal className="size-3 shrink-0" />
            <span>terminal</span>
          </>
        ) : (
          <>
            <AgentIcon type={session.agent_type ?? ''} className="size-3 shrink-0" />
            <span>{session.agent_type}</span>
            {accountLabel && <span> · {accountLabel}</span>}
          </>
        )}
      </span>
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
  accountLabel,
  activeSessionId,
  onPromote,
  onArchived,
}: {
  session: Session;
  accountLabel?: string;
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
                'flex items-center rounded-md p-1.5 transition-colors hover:bg-elevated compact:p-1',
                session.id === activeSessionId && 'bg-elevated',
              )}
            >
              {/* Active session marked with the same bg-elevated fill-shift the
                  expanded list and the navigator's mode icons use — a theme
                  colour, no border, no default-blue ring (HUMANS.md). The glyph
                  fills more of its container than the expanded rows' (SPEC §12:
                  the dot IS the row here). */}
              <SessionGlyph
                status={session.status}
                kind={session.kind}
                agentType={session.agent_type}
                stale={session.stale_running}
                className="size-4"
              />
              <span className="sr-only">{renderTitle(session)}</span>
            </Link>
          </TooltipTrigger>
        </ContextMenuTrigger>
        {/* To the left, into the workspace — a tooltip above the dot would sit
            on the dots before it in the rail. */}
        <TooltipContent side="left">
          <SessionLabel session={session} accountLabel={accountLabel} />
        </TooltipContent>
      </Tooltip>
      <SessionContextMenuBody menu={menu} />
      {dialogs}
    </ContextMenu>
  );
}

/**
 * The collapsed right sidebar: a slim rail whose expand / new-terminal /
 * new-session controls stay fixed at the top, then one clickable agent or
 * terminal glyph per live session — grouped by project with a divider and
 * compact project label between groups (SPEC §12). The glyphs scroll (no
 * visible scrollbar) so a long list still works.
 */
export function CollapsedSessionsRail({
  groups,
  accounts,
  activeProjectId,
  activeSessionId,
  onReorder,
  onPromote,
  onExpand,
  onNewTerminal,
  onNewSession,
  onArchived,
  projectActions,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  /** The URL-bound project: clicking ITS label edits the abbreviation in place. */
  activeProjectId: string | null;
  activeSessionId: string | null;
  onReorder: (ids: string[]) => void;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote: (id: string) => void;
  onExpand: () => void;
  onNewTerminal: () => void;
  onNewSession: () => void;
  onArchived: (id: string) => void;
  projectActions: ProjectHeaderActions;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [editingAbbrev, setEditingAbbrev] = useState<string | null>(null);
  const patchProject = usePatchProject();
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const move = (id: string, before: string) => {
    const next = moveWithinGroups(groups, id, before);
    if (next) onReorder(next);
  };
  const commitAbbrev = (group: SessionGroup, value: string) => {
    setEditingAbbrev(null);
    const next = normaliseAbbrev(value);
    if (!next || next === group.abbrev) return;
    patchProject.mutate({ id: group.projectId, abbrev: next }, { onError: (e) => toastError(e) });
  };
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center bg-surface py-1.5 compact:py-1">
      <div className="flex flex-col items-center gap-1 compact:gap-0.5">
        <IconButton
          icon={PanelRightOpen}
          label="Show sessions"
          onClick={onExpand}
          tooltipSide="left"
        />
        <IconButton icon={Bot} label="New agent" onClick={onNewSession} tooltipSide="left" />
        <IconButton
          icon={SquareTerminal}
          label="New terminal"
          onClick={onNewTerminal}
          tooltipSide="left"
        />
      </div>
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto compact:gap-0.5">
        {groups.map((group) => (
          // A divider precedes every group (the first one separates dots from
          // the controls above; the rest separate one project from the next).
          <div
            key={group.projectId}
            className="flex flex-col items-center gap-1 compact:gap-0.5"
            onDragOver={(e) => {
              if (!dragProject) return;
              e.preventDefault();
              if (dragProject !== group.projectId)
                projectActions.onMoveProject(dragProject, group.projectId);
            }}
          >
            <div className="my-0.5 h-px w-7 shrink-0 bg-border" />
            {/* Both triggers stack over the single <Link> (as the dots do): the
                tooltip shows the FULL project name the abbreviation stands for;
                right-click opens the new-agent/terminal menu; the label drags
                to reorder projects. Clicking the ACTIVE project's label edits
                the abbreviation in place — other labels navigate (SPEC §12). */}
            {editingAbbrev === group.projectId ? (
              <InlineLabelEdit
                initial={group.abbrev}
                maxLength={ABBREV_MAX}
                className="w-7 text-center font-mono text-[8px] uppercase leading-3 text-fg"
                onCommit={(v) => commitAbbrev(group, v)}
                onCancel={() => setEditingAbbrev(null)}
              />
            ) : (
              <ContextMenu>
                <Tooltip>
                  <ContextMenuTrigger asChild>
                    <TooltipTrigger asChild>
                      <Link
                        to={`/project/${group.projectId}`}
                        onClick={(e) => {
                          if (group.projectId !== activeProjectId) return;
                          e.preventDefault();
                          setEditingAbbrev(group.projectId);
                        }}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(PROJECT_MIME, group.projectId);
                          setDragProject(group.projectId);
                        }}
                        onDragEnd={() => setDragProject(null)}
                        className={cn(
                          'w-7 truncate text-center font-mono text-[8px] uppercase leading-3 text-fg-muted transition-colors hover:text-fg',
                          dragProject === group.projectId && 'opacity-50',
                        )}
                      >
                        {group.abbrev}
                      </Link>
                    </TooltipTrigger>
                  </ContextMenuTrigger>
                  <TooltipContent side="left">{group.name}</TooltipContent>
                </Tooltip>
                <ProjectMenuBody projectId={group.projectId} actions={projectActions} />
              </ContextMenu>
            )}
            <CollapsibleSessions collapsed={dragProject !== null}>
              <div className="flex flex-col items-center gap-1 overflow-hidden compact:gap-0.5">
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
                      accountLabel={
                        session.account_id === null
                          ? undefined
                          : accountLabel.get(session.account_id)
                      }
                      activeSessionId={activeSessionId}
                      onPromote={onPromote}
                      onArchived={onArchived}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleSessions>
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
            'group flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-elevated compact:gap-1.5 compact:py-1',
            session.id === activeSessionId && 'bg-elevated',
          )}
        >
          <SessionGlyph
            status={session.status}
            kind={session.kind}
            agentType={session.agent_type}
            stale={session.stale_running}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-sans text-xs text-fg">{renderTitle(session)}</span>
            <span className="flex items-center gap-1 truncate font-mono text-2xs text-fg-muted">
              <GitBranch className="size-3 shrink-0 text-fg-gold" />
              <span className="truncate">{session.branch}</span>
            </span>
            <span className="flex items-center gap-1 truncate font-mono text-2xs text-fg-muted">
              <span className="truncate">
                {session.kind === 'terminal' ? 'terminal' : (session.agent_type ?? 'agent')}
                {session.account_id !== null && accountLabel.has(session.account_id)
                  ? ` · ${accountLabel.get(session.account_id)}`
                  : ''}
              </span>
            </span>
          </span>
          {session.skip_permissions && (
            <Tooltip>
              <TooltipTrigger asChild>
                <ShieldOff className="size-3.5 shrink-0 text-warning" />
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
            <span className="hidden group-hover:inline-flex has-[[data-state=open]]:inline-flex pointer-coarse:inline-flex">
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
  activeProjectId,
  activeSessionId,
  onReorder,
  onPromote,
  archived,
  onNewSession,
  onNewTerminal,
  onCollapse,
  onArchived,
  projectActions,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  /** The URL-bound project: clicking ITS name header edits the name in place. */
  activeProjectId: string | null;
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
  projectActions: ProjectHeaderActions;
}) {
  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Fixed controls: collapse on the left edge; the Agent · Terminal
          symbols on the right (SPEC §8) — the Scratchpad lives in the top bar
          (SPEC §11), not here. */}
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <IconButton icon={PanelRightClose} label="Hide sessions" onClick={onCollapse} />
        <div className="ml-auto flex items-center gap-1">
          <IconButton icon={Bot} label="New agent" onClick={onNewSession} />
          <IconButton icon={SquareTerminal} label="New terminal" onClick={onNewTerminal} />
        </div>
      </div>
      <SessionListBody
        groups={groups}
        accounts={accounts}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        onReorder={onReorder}
        onPromote={onPromote}
        archived={archived}
        onArchived={onArchived}
        projectActions={projectActions}
      />
    </div>
  );
}

/** The session-list body (extracted so the sidebar shell can swap in Scratchpad). */
function SessionListBody({
  groups,
  accounts,
  activeProjectId,
  activeSessionId,
  onReorder,
  onPromote,
  archived,
  onArchived,
  projectActions,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  onReorder: (ids: string[]) => void;
  onPromote: (id: string) => void;
  archived: Session[];
  onArchived: (id: string) => void;
  projectActions: ProjectHeaderActions;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const patchProject = usePatchProject();
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const total = groups.reduce((n, g) => n + g.sessions.length, 0);

  const move = (id: string, before: string) => {
    const next = moveWithinGroups(groups, id, before);
    if (next) onReorder(next);
  };
  const commitName = (group: SessionGroup, value: string) => {
    setEditingName(null);
    const next = value.trim();
    if (!next || next === group.name) return;
    patchProject.mutate({ id: group.projectId, name: next }, { onError: (e) => toastError(e) });
  };

  return (
    <>
      {/* body */}
      {/* No horizontal padding: the active/hover fill-shift bleeds to both
          sidebar edges (each row carries its own px-3). Scrolls without a
          visible scrollbar so a long cross-project list still works. */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-1.5">
        {total === 0 && archived.length === 0 && (
          <p className="px-3 py-3 text-xs text-fg-muted">
            No sessions yet — press ⌘K to start one.
          </p>
        )}
        {groups.map((group) => (
          <div
            key={group.projectId}
            onDragOver={(e) => {
              if (!dragProject) return;
              e.preventDefault();
              if (dragProject !== group.projectId)
                projectActions.onMoveProject(dragProject, group.projectId);
            }}
          >
            {/* The header right-clicks into the new-agent/terminal menu and
                drags to reorder projects (the same projectOrder the homescreen
                cards persist); while any header drags, the session lists
                collapse so only the names reposition. Clicking the ACTIVE
                project's header edits the name in place — other headers
                navigate (SPEC §12). */}
            {editingName === group.projectId ? (
              <InlineLabelEdit
                initial={group.name}
                maxLength={100}
                className="block w-full px-3 pb-1 pt-2 text-2xs font-medium tracking-wide text-fg"
                onCommit={(v) => commitName(group, v)}
                onCancel={() => setEditingName(null)}
              />
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <Link
                    to={`/project/${group.projectId}`}
                    onClick={(e) => {
                      if (group.projectId !== activeProjectId) return;
                      e.preventDefault();
                      setEditingName(group.projectId);
                    }}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PROJECT_MIME, group.projectId);
                      setDragProject(group.projectId);
                    }}
                    onDragEnd={() => setDragProject(null)}
                    className={cn(
                      'block truncate px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-fg-gold transition-colors hover:text-fg compact:pb-0.5 compact:pt-1.5',
                      dragProject === group.projectId && 'opacity-50',
                    )}
                  >
                    {group.name}
                  </Link>
                </ContextMenuTrigger>
                <ProjectMenuBody projectId={group.projectId} actions={projectActions} />
              </ContextMenu>
            )}
            <CollapsibleSessions collapsed={dragProject !== null}>
              <ul className="flex flex-col gap-0.5 overflow-hidden compact:gap-0">
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
            </CollapsibleSessions>
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
            <ul className="no-scrollbar flex max-h-48 flex-col gap-0.5 overflow-y-auto compact:gap-0">
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
    </>
  );
}
