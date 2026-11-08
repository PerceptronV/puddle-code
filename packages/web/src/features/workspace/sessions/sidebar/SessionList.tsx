import { sessionTabRef } from '@puddle/shared';
import type { Account, Session } from '@puddle/shared';
import { Archive, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { InlineLabelEdit } from '../../../../components/inline-label-edit';
import { HeightHandle, useResizableHeight } from '../../../../components/resizable-height';
import {
  ContextMenu,
  ContextMenuTrigger,
  menuOnDoubleClick,
} from '../../../../components/ui/context-menu';
import {
  appearanceColourClass,
  appearanceColourStyle,
} from '../../../../lib/appearance/appearance-colours';
import { useHotkeyLabel } from '../../../../lib/navigation/hotkeys';
import { usePatchProject } from '../../../../lib/queries/queries';
import { toastError } from '../../../../lib/transport/errors';
import { cn } from '../../../../lib/utils';
import { relativeTime } from '../../../history/history-logic';
import { useSessionTitleRenderer } from '../../../profile/use-session-title';
import { useActiveDragRef } from '../../layout/TilingDnd';
import { encodeTabTransfer, TAB_MIME } from '../../tabs/tab-transfer';
import { moveWithinGroups } from '../session-order';
import { encodeSessionDrag, SESSION_DRAG_MIME, sessionsForDrag } from '../session-selection';
import { SessionHoverList } from '../SessionHoverList';
import { CollapsibleSessions } from './controls';
import { setCountDragImage, useArchiveDrop } from './drag';
import { PROJECT_MIME, ProjectMenuBody } from './project-controls';
import { SessionRow } from './SessionRow';
import type { ProjectHeaderActions, SessionGroup, SidebarSessionSelection } from './types';
import { beginProjectWindowDrag, canDragProjectWindow } from '../../../windows/drag/project-drag';

/** The session-list body (extracted so the sidebar shell can swap in Scratchpad). */
export function SessionListBody({
  header,
  query,
  groups,
  accounts,
  activeSessionId,
  onReorder,
  onPromote,
  archived,
  onArchived,
  onArchiveDrop,
  selection,
  projectActions,
}: {
  header: ReactNode;
  query: string;
  groups: SessionGroup[];
  accounts: Account[];
  activeSessionId: string | null;
  onReorder: (ids: string[]) => void;
  onPromote: (id: string) => void;
  archived: Session[];
  onArchived: (id: string) => void;
  onArchiveDrop: (sessions: readonly string[]) => void;
  selection: SidebarSessionSelection;
  projectActions: ProjectHeaderActions;
}) {
  const [dragging, setDragging] = useState<{
    sourceId: string;
    sessionIds: readonly string[];
  } | null>(null);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // The Archived header doubles as the archive drop target; while a session
  // drags (a row here, or a centre tab chip) it appears even with nothing
  // archived yet, so there is always somewhere to drop.
  const archiveDrop = useArchiveDrop('list', onArchiveDrop);
  const activeDragRef = useActiveDragRef();
  const sessionDragActive =
    dragging !== null || (activeDragRef !== null && activeDragRef.type !== 'editor');
  const patchProject = usePatchProject();
  const paletteKey = useHotkeyLabel('palette.toggle');
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const renderTitle = useSessionTitleRenderer();
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filterGroups = (source: SessionGroup[], isArchived = false) => {
    if (terms.length === 0) return source;
    return source
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => {
          const details = [
            group.name,
            renderTitle(session),
            session.branch,
            session.kind === 'agent' ? (session.agent_type ?? 'agent') : session.kind,
            isArchived
              ? session.last_activity_at === null
                ? ''
                : relativeTime(session.last_activity_at)
              : session.account_id === null
                ? ''
                : accountLabel.get(session.account_id),
          ]
            .join(' ')
            .toLocaleLowerCase();
          return terms.every((term) => details.includes(term));
        }),
      }))
      .filter((group) => group.sessions.length > 0);
  };
  const displayedGroups = filterGroups(groups);
  const total = groups.reduce((n, g) => n + (g.collapsed ? 0 : g.sessions.length), 0);
  const visibleIds = useMemo(
    () =>
      displayedGroups.flatMap((group) =>
        (group.collapsed ? [] : group.sessions).map((session) => session.id),
      ),
    [displayedGroups],
  );
  const selectedIds = visibleIds.filter((id) => selection.ids.has(id));
  // The open archived pane's height, dragged by the border above its header.
  const { height: archivedHeight, handle } = useResizableHeight('sessions-archived', 200, {
    sized: 'below',
    min: 96,
  });
  // Archived sessions grouped like the live ones (SPEC §12), in the same project
  // order — a flat list of every project's archives was unreadable once more
  // than one project had any. A session whose project has no group (an archived
  // project) still lists, under no header, rather than disappearing.
  const archivedGroups = useMemo<SessionGroup[]>(() => {
    const placed = new Set<string>();
    const byProject = groups.map((g) => {
      const rows = archived.filter((s) => s.project_id === g.projectId);
      for (const s of rows) placed.add(s.id);
      return { ...g, sessions: rows };
    });
    const orphans = archived.filter((s) => !placed.has(s.id));
    return [
      ...byProject.filter((g) => g.sessions.length > 0),
      ...(orphans.length > 0
        ? [{ projectId: '', name: '', abbrev: '', colour: null, repoId: -1, sessions: orphans }]
        : []),
    ];
  }, [groups, archived]);

  const displayedArchivedGroups = filterGroups(archivedGroups, true);
  const noMatches =
    terms.length > 0 &&
    displayedGroups.length === 0 &&
    (!showArchived || displayedArchivedGroups.length === 0);

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
      <div className="workspace-surface island-outline grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] bg-surface">
        {header}
        {/* body */}
        {/* No horizontal padding: the active/hover fill-shift bleeds to both
          sidebar edges (each row carries its own px-3). Scrolls without a
          visible scrollbar so a long cross-project list still works. */}
        {/* Initial clearance scrolls away with the list, leaving only the two
            control islands above the content. Include tray and header padding. */}
        <SessionHoverList className="no-scrollbar col-start-1 row-start-1 min-h-0 overflow-y-auto overscroll-contain pb-1.5 pt-[calc(var(--ui-control-height)+1.5rem)]">
          {terms.length === 0 && total === 0 && archived.length === 0 && (
            <p className="px-3 py-3 text-xs text-fg-muted">
              No sessions yet — press {paletteKey} to start one.
            </p>
          )}
          {noMatches && (
            <p role="status" className="px-3 py-3 text-xs text-fg-muted">
              No matching sessions.
            </p>
          )}
          {displayedGroups.map((group) => (
            <div
              key={group.projectId}
              data-session-project={group.projectId}
              className="mx-2 border-t border-border py-1 first:border-t-0"
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
                collapse so only the names reposition. A single click navigates
                (any project); a DOUBLE-click opens the same menu, where Change
                project name sits among the other actions (decision
                2026-08-05 — see the collapsed rail's abbreviation). */}
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
                      data-sidebar-motion={`sessions-project-${group.projectId}`}
                      style={appearanceColourStyle(group.colour)}
                      {...menuOnDoubleClick()}
                      draggable
                      title={
                        canDragProjectWindow(group.projectId)
                          ? 'Drag project back to its host window'
                          : undefined
                      }
                      onDragStart={(e) => {
                        if (beginProjectWindowDrag(e.dataTransfer, group.projectId)) return;
                        e.dataTransfer.setData(PROJECT_MIME, group.projectId);
                        setDragProject(group.projectId);
                      }}
                      onDragEnd={() => setDragProject(null)}
                      className={cn(
                        'block truncate px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide transition-colors compact:pb-0.5 compact:pt-1.5',
                        canDragProjectWindow(group.projectId) &&
                          'cursor-grab active:cursor-grabbing',
                        group.colour
                          ? cn(appearanceColourClass(group.colour), 'hover:opacity-75')
                          : 'text-fg-gold hover:text-fg',
                        dragProject === group.projectId && 'opacity-50',
                      )}
                    >
                      {group.name}
                    </Link>
                  </ContextMenuTrigger>
                  <ProjectMenuBody
                    projectId={group.projectId}
                    name={group.name}
                    colour={group.colour}
                    actions={projectActions}
                    editLabel={{
                      label: 'Change project name',
                      onSelect: () => setEditingName(group.projectId),
                    }}
                  />
                </ContextMenu>
              )}
              <CollapsibleSessions collapsed={!!group.collapsed || dragProject !== null}>
                <ul className="flex flex-col gap-0.5 overflow-hidden compact:gap-0">
                  {group.sessions.map((session) => (
                    <li
                      key={session.id}
                      draggable
                      onDragStart={(e) => {
                        const sessionIds = sessionsForDrag(visibleIds, selection.ids, session.id);
                        // Reorders within the list AND, dropped on a tiling pane,
                        // opens the grabbed session there as a permanent tab. A
                        // selected batch travels beside that single-tab payload
                        // for the archive target.
                        e.dataTransfer.setData(
                          TAB_MIME,
                          encodeTabTransfer(sessionTabRef(session), {
                            projectId: session.project_id,
                          }),
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
                      <SessionRow
                        session={session}
                        activeSessionId={activeSessionId}
                        accountLabel={accountLabel}
                        onPromote={onPromote}
                        onArchived={onArchived}
                        selectedIds={selectedIds}
                        selection={selection}
                        ellipsis
                      />
                    </li>
                  ))}
                </ul>
              </CollapsibleSessions>
            </div>
          ))}
        </SessionHoverList>
      </div>
      {/* Archived sessions: hidden by default under a collapsible header at the
          bottom, never deleted — click one to reopen it and read its history
          (SPEC §4). Open, the pane is GROUPED BY PROJECT exactly as the live
          list is, each row saying when it was last active, and its top border
          drags to give the pane more (or less) of the sidebar. */}
      {(archived.length > 0 || sessionDragActive) && (
        <>
          {!showArchived && <div className="h-[var(--ui-surface-gap)] shrink-0" />}
          {showArchived && <HeightHandle handle={handle} label="Resize the archived sessions" />}
          <div
            className="workspace-surface island-outline flex shrink-0 flex-col bg-surface pb-1.5"
            // Sized only while open (closed, the header is all there is). The
            // percentage cap resolves against the sidebar's own definite height,
            // so a pane dragged tall elsewhere cannot swallow the live list here.
            style={showArchived ? { height: archivedHeight, maxHeight: '70%' } : undefined}
          >
            <button
              data-sidebar-motion="sessions-archive"
              ref={archiveDrop.setNodeRef}
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              {...archiveDrop.props}
              className={cn(
                'flex w-full items-center gap-1.5 px-3 py-1.5 text-2xs uppercase tracking-wide text-fg-gold transition-colors hover:text-fg',
                archiveDrop.armed && 'bg-selection text-fg',
              )}
            >
              <ChevronRight
                className={cn('size-3 transition-transform', showArchived && 'rotate-90')}
              />
              <Archive className="size-3" />
              <span>Archived</span>
              <span className="ml-auto tabular-nums">{archived.length}</span>
            </button>
            {showArchived && (
              <SessionHoverList className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {displayedArchivedGroups.map((group) => (
                  <div
                    key={group.projectId}
                    data-session-project={group.projectId}
                    className="mx-2 border-t border-border py-1 first:border-t-0"
                  >
                    {/* Dimmer than a live group's header and inert: archived rows
                        are for finding one session again, not for navigating
                        projects (that is the live list's header, right above). */}
                    {group.name !== '' && (
                      <div
                        style={appearanceColourStyle(group.colour)}
                        className={cn(
                          'truncate px-3 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide',
                          group.colour
                            ? cn(appearanceColourClass(group.colour), 'opacity-70')
                            : 'text-fg-muted',
                        )}
                      >
                        {group.name}
                      </div>
                    )}
                    <ul className="flex flex-col gap-0.5 compact:gap-0">
                      {group.sessions.map((session) => (
                        <li key={session.id}>
                          <SessionRow
                            session={session}
                            activeSessionId={activeSessionId}
                            accountLabel={accountLabel}
                            onArchived={onArchived}
                            ellipsis
                            lastActive
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </SessionHoverList>
            )}
          </div>
        </>
      )}
    </>
  );
}
