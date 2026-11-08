import type { Account, Session } from '@puddle/shared';
import { Archive, Bot, PanelRightOpen, Search, SquareTerminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AgentIcon } from '../../../../components/agent-icon';
import { InlineLabelEdit } from '../../../../components/inline-label-edit';
import {
  ContextMenu,
  ContextMenuTrigger,
  menuOnDoubleClick,
} from '../../../../components/ui/context-menu';
import { ControlTray } from '../../../../components/ui/control-tray';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import {
  appearanceColourClass,
  appearanceColourStyle,
} from '../../../../lib/appearance/appearance-colours';
import { ABBREV_MAX, normaliseAbbrev } from '../../../../lib/project-abbrev';
import { usePatchProject } from '../../../../lib/queries/queries';
import { toastError } from '../../../../lib/transport/errors';
import { cn } from '../../../../lib/utils';
import { useSessionTitleRenderer } from '../../../profile/use-session-title';
import { SessionGlyph } from '../../../status/SessionGlyph';
import { encodeTabTransfer, TAB_MIME } from '../../tabs/tab-transfer';
import { ProjectAbbreviation, useProjectAbbreviationSize } from '../ProjectAbbreviation';
import { SessionContextMenuBody, useSessionMenu } from '../SessionActions';
import { SessionHoverList } from '../SessionHoverList';
import { moveWithinGroups } from '../session-order';
import { encodeSessionDrag, SESSION_DRAG_MIME, sessionsForDrag } from '../session-selection';
import '../session-sidebar.css';
import { CollapsibleSessions, IconButton } from './controls';
import { setCountDragImage, useArchiveDrop } from './drag';
import { PROJECT_MIME, ProjectMenuBody } from './project-controls';
import type { ProjectHeaderActions, SessionGroup, SidebarSessionSelection } from './types';
import { beginProjectWindowDrag, canDragProjectWindow } from '../../../windows/drag/project-drag';

/** The collapsed rail's archive target: an icon at the rail's foot. */
function RailArchiveTarget({
  onArchiveDrop,
  onExpand,
}: {
  onArchiveDrop: (sessions: readonly string[]) => void;
  onExpand: () => void;
}) {
  const drop = useArchiveDrop('rail', onArchiveDrop);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          data-sidebar-motion="sessions-archive"
          ref={drop.setNodeRef}
          type="button"
          onClick={onExpand}
          {...drop.props}
          className={cn(
            'island-outline mt-auto flex min-h-9 w-full shrink-0 items-center justify-center rounded-[var(--ui-surface-radius)] bg-tray p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg compact:p-1',
            drop.armed && 'bg-selection text-fg',
          )}
        >
          <Archive className="size-4" />
          <span className="sr-only">Archived sessions</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">Drop selected sessions here to archive them</TooltipContent>
    </Tooltip>
  );
}

/** Name over branch over agent · account — the tooltip for a collapsed dot. */
function SessionLabel({ session, accountLabel }: { session: Session; accountLabel?: string }) {
  const renderTitle = useSessionTitleRenderer();
  return (
    <span className="flex flex-col">
      <span>{renderTitle(session)}</span>
      <span className="text-2xs text-fg-muted">{session.branch}</span>
      <span className="mt-0.5 flex items-center gap-1 text-2xs text-fg-muted">
        {session.kind === 'huddle' ? (
          <span>huddle</span>
        ) : session.kind === 'terminal' ? (
          <>
            {session.detected_agent_type ? (
              <AgentIcon type={session.detected_agent_type} className="size-3 shrink-0" />
            ) : (
              <SquareTerminal className="size-3 shrink-0" />
            )}
            <span>
              {session.detected_agent_type
                ? `${session.detected_agent_type} · terminal`
                : 'terminal'}
            </span>
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
 * One collapsed-rail status glyph: navigates on click (to its own project, so the
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
  selectedIds,
  selection,
}: {
  session: Session;
  accountLabel?: string;
  activeSessionId: string | null;
  onPromote: (id: string) => void;
  onArchived: (id: string) => void;
  selectedIds: readonly string[];
  selection: SidebarSessionSelection;
}) {
  const { menu, dialogs } = useSessionMenu(session, onArchived);
  const renderTitle = useSessionTitleRenderer();
  const selected = selection.ids.has(session.id);
  const batch =
    selected && selectedIds.length > 1
      ? { sessionIds: selectedIds, archiveAll: selection.onArchive }
      : undefined;
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
              onClick={(e) => {
                const modified = e.shiftKey || e.metaKey || e.ctrlKey;
                selection.onSelect(session.id, {
                  shift: e.shiftKey,
                  toggle: e.metaKey || e.ctrlKey,
                });
                if (modified) e.preventDefault();
              }}
              onDoubleClick={() => onPromote(session.id)}
              onContextMenu={() => {
                if (!selected) selection.onSelectOnly(session.id);
              }}
              to={`/project/${session.project_id}/session/${session.id}`}
              data-sidebar-motion={`sessions-item-${session.id}`}
              data-session-hover
              data-session-active={session.id === activeSessionId || undefined}
              aria-selected={selected}
              className={cn(
                'session-hover-row relative flex items-center rounded-[var(--ui-radius)] p-1 transition-colors',
                (selected || session.id === activeSessionId) && 'bg-explorer-selection',
              )}
            >
              {/* Active sessions use the deeper selection fill in both sidebar modes.
                  Sizing
                  settled by eye against the live rail (2026-08-06, three
                  rounds): 20px marks comfortable / 16px compact at 0.75×
                  stroke — the mark full-bleeds its box rather than floating a
                  12px icon in a 16px one, which is what made the marks swim in
                  their chips. */}
              <SessionGlyph
                status={session.status}
                kind={session.kind}
                agentType={session.agent_type}
                detectedAgentType={session.detected_agent_type}
                stale={session.stale_running}
                className="size-5 shrink-0 compact:size-4"
                iconClassName="size-full"
                iconStrokeScale={0.75}
              />
              <span className="sr-only">{renderTitle(session)}</span>
            </Link>
          </TooltipTrigger>
        </ContextMenuTrigger>
        {/* To the left, into the workspace — a tooltip above the glyph would sit
            on the glyphs before it in the rail. */}
        <TooltipContent side="left">
          <SessionLabel session={session} accountLabel={accountLabel} />
        </TooltipContent>
      </Tooltip>
      <SessionContextMenuBody menu={menu} batch={batch} />
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
  activeSessionId,
  onReorder,
  onPromote,
  onExpand,
  onSearch,
  onNewTerminal,
  onNewSession,
  onArchived,
  onArchiveDrop,
  selection,
  projectActions,
}: {
  groups: SessionGroup[];
  accounts: Account[];
  activeSessionId: string | null;
  onReorder: (ids: string[]) => void;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote: (id: string) => void;
  onExpand: () => void;
  onSearch: () => void;
  onNewTerminal: () => void;
  onNewSession: () => void;
  onArchived: (id: string) => void;
  /** A session dropped on the rail's archive icon: archive it (SPEC §12). */
  onArchiveDrop: (sessions: readonly string[]) => void;
  selection: SidebarSessionSelection;
  projectActions: ProjectHeaderActions;
}) {
  const [dragging, setDragging] = useState<{
    sourceId: string;
    sessionIds: readonly string[];
  } | null>(null);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [editingAbbrev, setEditingAbbrev] = useState<string | null>(null);
  const abbreviationRail = useProjectAbbreviationSize(
    JSON.stringify([groups.map(({ projectId, abbrev }) => [projectId, abbrev]), editingAbbrev]),
  );
  const patchProject = usePatchProject();
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const visibleIds = useMemo(
    () =>
      groups.flatMap((group) =>
        (group.collapsed ? [] : group.sessions).map((session) => session.id),
      ),
    [groups],
  );
  const selectedIds = visibleIds.filter((id) => selection.ids.has(id));
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
    <div
      ref={abbreviationRail}
      className="flex h-full min-h-0 w-9 shrink-0 flex-col items-center gap-[var(--ui-surface-gap)] overflow-hidden"
    >
      <div className="relative flex w-full shrink-0 flex-col items-center gap-1 compact:gap-0.5">
        <ControlTray label="New sessions" variant="island" vertical>
          <IconButton
            icon={PanelRightOpen}
            label="Show sessions"
            onClick={onExpand}
            tooltipSide="left"
          />
          <div aria-hidden="true" className="mx-1 h-px self-stretch bg-border" />
          <IconButton icon={Bot} label="New agent" onClick={onNewSession} tooltipSide="left" />
          <IconButton
            icon={SquareTerminal}
            label="New terminal"
            onClick={onNewTerminal}
            tooltipSide="left"
          />
          <IconButton icon={Search} label="Search sessions" onClick={onSearch} tooltipSide="left" />
        </ControlTray>
      </div>
      <SessionHoverList className="collapsed-session-list workspace-surface island-outline no-scrollbar flex min-h-0 w-full shrink flex-col items-center overflow-y-auto overscroll-contain bg-tray">
        {groups.map((group) => (
          // Projects share one scrollable island; inset dividers separate them.
          <div
            key={group.projectId}
            data-session-project={group.projectId}
            className="collapsed-session-project relative flex w-full shrink-0 flex-col items-center gap-1 py-1.5 compact:py-2"
            onDragOver={(e) => {
              if (!dragProject) return;
              e.preventDefault();
              if (dragProject !== group.projectId)
                projectActions.onMoveProject(dragProject, group.projectId);
            }}
          >
            {/* Both triggers stack over the single <Link> (as the dots do): the
                tooltip shows the FULL project name the abbreviation stands for;
                right-click opens the new-agent/terminal menu; the label drags
                to reorder projects. A single click navigates (any project); a
                DOUBLE-click opens that same menu (decision 2026-08-05 — it used
                to go straight into the abbreviation editor, which picks one of
                the menu's actions on the user's behalf; Change project
                abbreviation is still one click away inside it). */}
            {editingAbbrev === group.projectId ? (
              <InlineLabelEdit
                initial={group.abbrev}
                maxLength={ABBREV_MAX}
                className="w-full px-1 text-center text-2xs uppercase text-fg"
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
                        data-sidebar-motion={`sessions-project-${group.projectId}`}
                        style={appearanceColourStyle(group.colour)}
                        {...menuOnDoubleClick()}
                        draggable
                        onDragStart={(e) => {
                          if (beginProjectWindowDrag(e.dataTransfer, group.projectId)) return;
                          e.dataTransfer.setData(PROJECT_MIME, group.projectId);
                          setDragProject(group.projectId);
                        }}
                        onDragEnd={() => setDragProject(null)}
                        className={cn(
                          'w-full px-1 text-center text-2xs uppercase transition-colors',
                          canDragProjectWindow(group.projectId) &&
                            'cursor-grab active:cursor-grabbing',
                          group.colour
                            ? cn(appearanceColourClass(group.colour), 'hover:opacity-75')
                            : 'text-fg-muted hover:text-fg',
                          dragProject === group.projectId && 'opacity-50',
                        )}
                      >
                        <ProjectAbbreviation text={group.abbrev} />
                      </Link>
                    </TooltipTrigger>
                  </ContextMenuTrigger>
                  <TooltipContent side="left">
                    {group.name}
                    {canDragProjectWindow(group.projectId) ? ' · Drag back to host' : ''}
                  </TooltipContent>
                </Tooltip>
                <ProjectMenuBody
                  projectId={group.projectId}
                  name={group.name}
                  colour={group.colour}
                  actions={projectActions}
                  editLabel={{
                    label: 'Change project abbreviation',
                    onSelect: () => setEditingAbbrev(group.projectId),
                  }}
                />
              </ContextMenu>
            )}
            {group.sessions.length > 0 && (
              <CollapsibleSessions collapsed={!!group.collapsed || dragProject !== null}>
                <div className="flex flex-col items-center gap-1 overflow-hidden compact:gap-0.5">
                  {group.sessions.map((session) => (
                    <div
                      key={session.id}
                      draggable
                      onDragStart={(e) => {
                        const sessionIds = sessionsForDrag(visibleIds, selection.ids, session.id);
                        // The same drag reorders within the rail AND, dropped on a
                        // tiling pane, opens the grabbed session there as a
                        // permanent tab. The companion payload lets the archive
                        // target act on the whole selection.
                        e.dataTransfer.setData(
                          TAB_MIME,
                          encodeTabTransfer(
                            { type: 'terminal', session: session.id },
                            { projectId: session.project_id },
                          ),
                        );
                        e.dataTransfer.setData(SESSION_DRAG_MIME, encodeSessionDrag(sessionIds));
                        e.dataTransfer.effectAllowed = 'copyMove';
                        if (sessionIds.length > 1) setCountDragImage(e, sessionIds.length);
                        if (!selection.ids.has(session.id)) selection.onSelectOnly(session.id);
                        setDragging({ sourceId: session.id, sessionIds });
                      }}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragging?.sessionIds.length === 1 && dragging.sourceId !== session.id)
                          move(dragging.sourceId, session.id);
                      }}
                      className={cn(
                        'transition-opacity',
                        dragging?.sessionIds.includes(session.id) && 'opacity-50',
                      )}
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
                        selectedIds={selectedIds}
                        selection={selection}
                      />
                    </div>
                  ))}
                </div>
              </CollapsibleSessions>
            )}
          </div>
        ))}
      </SessionHoverList>
      {/* The rail's foot: sessions dragged here — glyphs above or centre tab
          chips — archive; a click expands the sidebar to the full list. */}
      <RailArchiveTarget onArchiveDrop={onArchiveDrop} onExpand={onExpand} />
    </div>
  );
}
