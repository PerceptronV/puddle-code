import type { Session } from '@puddle/shared';
import { FolderX, GitBranch, MessageCircleX, ShieldOff, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { HoverMarquee } from '../../../../components/hover-marquee';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utils';
import { relativeTime } from '../../../history/history-logic';
import { useSessionTitleRenderer } from '../../../profile/use-session-title';
import { SessionGlyph } from '../../../status/SessionGlyph';
import { SessionActionsEllipsis, SessionContextMenu } from '../SessionActions';
import type { SidebarSessionSelection } from './types';

/** Which hover drives a session row's marquees: the row itself (`group`). */
const ROW_MARQUEE = 'group-hover:[transform:translateX(var(--tail))]';

/** One expanded-sidebar row: display-name title over branch/account lines. */
export function SessionRow({
  session,
  activeSessionId,
  accountLabel,
  onPromote,
  onArchived,
  selectedIds,
  selection,
  ellipsis,
  lastActive = false,
}: {
  session: Session;
  activeSessionId: string | null;
  accountLabel: Map<number, string>;
  /** Double-click: pin the session's (preview) terminal tab. */
  onPromote?: (id: string) => void;
  onArchived: (id: string) => void;
  selectedIds?: readonly string[];
  selection?: SidebarSessionSelection;
  /** Whether to mount the hover ellipsis (archived rows omit it). */
  ellipsis: boolean;
  /**
   * Show when the session was last active instead of its agent · account line —
   * for archived rows, where "how long ago did I stop working on this" is the
   * only thing that orders a long list (nothing is running to have a status).
   */
  lastActive?: boolean;
}) {
  const renderTitle = useSessionTitleRenderer();
  const selected = selection?.ids.has(session.id) ?? false;
  const batch =
    selection && selected && selectedIds && selectedIds.length > 1
      ? { sessionIds: selectedIds, archiveAll: selection.onArchive }
      : undefined;
  const kindLabel = session.kind === 'agent' ? (session.agent_type ?? 'agent') : session.kind;
  // An archived row trades its account for its last activity — the account is
  // fixed for the session's life and interesting while it runs; once archived,
  // when you last touched it is what tells the list apart.
  const suffix = lastActive
    ? session.last_activity_at === null
      ? ''
      : ` · ${relativeTime(session.last_activity_at)}`
    : session.account_id !== null && accountLabel.has(session.account_id)
      ? ` · ${accountLabel.get(session.account_id)}`
      : '';
  return (
    <SessionContextMenu session={session} onArchived={onArchived} batch={batch}>
      {(menu) => (
        <Link
          // draggable=false: let the <li> own the drag (reorder), not the
          // anchor's native "drag the URL" behaviour. Click still navigates — to
          // its own project, so the cross-project list switches projects too.
          draggable={false}
          // Single click = preview terminal (via navigation); double click
          // pins it, matching the file tree's single/double-click semantics.
          onClick={(e) => {
            if (!selection) return;
            const modified = e.shiftKey || e.metaKey || e.ctrlKey;
            selection.onSelect(session.id, {
              shift: e.shiftKey,
              toggle: e.metaKey || e.ctrlKey,
            });
            if (modified) e.preventDefault();
          }}
          onDoubleClick={onPromote && (() => onPromote(session.id))}
          onContextMenu={() => {
            if (selection && !selected) selection.onSelectOnly(session.id);
          }}
          to={`/project/${session.project_id}/session/${session.id}`}
          data-sidebar-motion={`sessions-item-${session.id}`}
          data-session-hover
          data-session-active={session.id === activeSessionId || undefined}
          aria-selected={selection ? selected : undefined}
          className={cn(
            'session-hover-row sidebar-row group relative flex items-center gap-[var(--ui-item-gap)] px-2 py-2 transition-colors compact:py-1.5',
            (selected || session.id === activeSessionId) && 'bg-explorer-selection',
          )}
        >
          <SessionGlyph
            status={session.status}
            kind={session.kind}
            agentType={session.agent_type}
            detectedAgentType={session.detected_agent_type}
            stale={session.stale_running}
          />
          {/* All three lines ease leftwards on the row's hover, at the app's one
              marquee speed — an agent names its own sessions, so the title is
              the label most likely to be clipped, and it is exactly the one you
              hover the row to read. */}
          <span className="min-w-0 flex-1">
            <HoverMarquee
              text={renderTitle(session)}
              className="font-sans text-xs text-fg"
              hoverClass={ROW_MARQUEE}
            />
            <span className="flex items-center gap-1 text-2xs text-fg-muted">
              <GitBranch className="size-3 shrink-0 text-fg-gold" />
              <HoverMarquee text={session.branch} hoverClass={ROW_MARQUEE} />
            </span>
            <span className="flex items-center gap-1 text-2xs text-fg-muted">
              <HoverMarquee text={`${kindLabel}${suffix}`} hoverClass={ROW_MARQUEE} />
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
          {session.conversation_missing && (
            <Tooltip>
              <TooltipTrigger asChild>
                <MessageCircleX className="size-3.5 shrink-0 text-interrupted" />
              </TooltipTrigger>
              <TooltipContent>Native conversation is missing — resume unavailable</TooltipContent>
            </Tooltip>
          )}
          {session.native_sync === 'fallback' && session.status !== 'archived' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <TriangleAlert className="size-3.5 shrink-0 text-fg-muted" />
              </TooltipTrigger>
              <TooltipContent>In-agent conversation switches are not synchronised</TooltipContent>
            </Tooltip>
          )}
          {/* Float over the row without changing title width. Keep the island
              visible while focused or while its menu is open. */}
          {ellipsis && (
            <span className="absolute right-2 top-1/2 z-10 -translate-y-1/2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto has-[[data-state=open]]:opacity-100 has-[[data-state=open]]:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto">
              <SessionActionsEllipsis menu={menu} />
            </span>
          )}
        </Link>
      )}
    </SessionContextMenu>
  );
}
