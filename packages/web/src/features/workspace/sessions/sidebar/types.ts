import type { Project, Session } from '@puddle/shared';
import type { SessionSelectionModifiers } from '../session-selection';

/**
 * A project's sessions for the sidebar. Groups are retained even when empty so
 * the project itself remains a navigation target (SPEC §12).
 */
export interface SessionGroup {
  projectId: string;
  name: string;
  /** The collapsed rail's ≤5-char label (stored abbrev, else derived — SPEC §12). */
  abbrev: string;
  colour?: Project['colour'];
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

/** Selection state shared by the expanded list and collapsed rail. */
export interface SidebarSessionSelection {
  ids: ReadonlySet<string>;
  onSelect: (id: string, modifiers: SessionSelectionModifiers) => void;
  onSelectOnly: (id: string) => void;
  onArchive: (ids: readonly string[]) => void;
}
