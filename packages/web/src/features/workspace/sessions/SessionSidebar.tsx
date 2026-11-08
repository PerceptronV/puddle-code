import { PuddleGlyph } from '../../../components/puddle-glyph';
import type { Account, Session } from '@puddle/shared';
import { Bot, PanelRightClose, Search, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ControlTray } from '../../../components/ui/control-tray';
import './session-sidebar.css';
import { SessionListBody } from './sidebar/SessionList';
import { IconButton } from './sidebar/controls';
import type { ProjectHeaderActions, SessionGroup, SidebarSessionSelection } from './sidebar/types';

/**
 * Session list: a display-font title over the mono branch (git-branch icon) and
 * account (agent-brand icon) lines, live status glyphs, badges, lifecycle menu.
 * Sessions are grouped by project (a header per project in the cross-project
 * view); the list scrolls with no visible scrollbar while the controls stay
 * fixed. Archived sessions are not deleted — they collapse into a disclosure at
 * the bottom so they stay reachable (SPEC §4, §12).
 */
export function SessionSidebar({
  searching,
  setSearching,
  groups,
  accounts,
  activeSessionId,
  onReorder,
  onPromote,
  archived,
  onNewSession,
  onNewHuddle,
  onNewTerminal,
  onCollapse,
  onArchived,
  onArchiveDrop,
  selection,
  projectActions,
}: {
  searching: boolean;
  setSearching: (value: boolean) => void;
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
  onNewHuddle?: () => void;
  onNewTerminal: () => void;
  onCollapse: () => void;
  onArchived: (id: string) => void;
  /** A session dropped on the Archived header: archive it (SPEC §12). */
  onArchiveDrop: (sessions: readonly string[]) => void;
  selection: SidebarSessionSelection;
  projectActions: ProjectHeaderActions;
}) {
  const [query, setQuery] = useState('');
  const controlsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
    requestAnimationFrame(() => {
      controlsRef.current
        ?.querySelector<HTMLButtonElement>('[aria-label="New sessions"] > button:last-child')
        ?.focus();
    });
  };
  const controls = (
    <div
      ref={controlsRef}
      className="session-sidebar-controls pointer-events-none z-10 col-start-1 row-start-1 self-start"
      data-searching={searching}
    >
      {!searching && (
        <div className="pointer-events-auto flex items-center">
          <IconButton icon={PanelRightClose} label="Hide sessions" onClick={onCollapse} />
        </div>
      )}
      <ControlTray
        label={searching ? 'Search sessions' : 'New sessions'}
        variant="selection"
        className="session-sidebar-search-tray pointer-events-auto"
      >
        {searching ? (
          <>
            <Search className="ml-1 size-4 shrink-0 text-fg-muted" />
            <input
              ref={inputRef}
              type="search"
              aria-label="Search displayed sessions"
              placeholder="Search sessions…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                }
              }}
              className="h-[var(--ui-control-height)] min-w-0 flex-1 bg-transparent text-xs text-fg outline-none"
            />
            <IconButton icon={X} label="Close session search" onClick={closeSearch} />
          </>
        ) : (
          <>
            <IconButton icon={Bot} label="New agent" onClick={onNewSession} />
            {onNewHuddle && (
              <IconButton icon={PuddleGlyph} label="New huddle" onClick={onNewHuddle} />
            )}
            <IconButton icon={SquareTerminal} label="New terminal" onClick={onNewTerminal} />
            <IconButton icon={Search} label="Search sessions" onClick={() => setSearching(true)} />
          </>
        )}
      </ControlTray>
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionListBody
        header={controls}
        query={query}
        groups={groups}
        accounts={accounts}
        activeSessionId={activeSessionId}
        onReorder={onReorder}
        onPromote={onPromote}
        archived={archived}
        onArchived={onArchived}
        onArchiveDrop={onArchiveDrop}
        selection={selection}
        projectActions={projectActions}
      />
    </div>
  );
}
