import type { ReactNode } from 'react';
import { CornerLeftUp, Undo2 } from 'lucide-react';
import type { Session } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { tildify } from '../../lib/tildify';
import { useHostInfo } from '../../lib/queries';
import { ExplorerProvider } from './explorer-context';
import { FileExplorer } from './FileExplorer';

/**
 * The tree the explorer switches to when navigating ABOVE the worktree
 * (SPEC §8). It is the SAME tree — `ExplorerProvider` + `FileExplorer`, given a
 * browse `root` instead of the session's worktree — so everything a right-click
 * offers inside the worktree works out here too: create, rename, delete,
 * cut/copy/paste, drag-move, upload, download. Files open as fully editable
 * `external` tabs (10.4). Only two things are genuinely worktree-shaped and so
 * absent: git decorations (the status endpoint is worktree-scoped) and "Open
 * Terminal in Directory" (the daemon confines a terminal's `cwd` to the
 * worktree, 11.1).
 *
 * `readOnly` covers the one case where the mutations must NOT be offered: a
 * daemon older than protocol 12.3 ignores `?root=` on the fs routes and would
 * resolve those paths against the worktree, silently touching the wrong files.
 *
 * The header walks further up and returns to the worktree.
 */
export function BrowseTree({
  session,
  root,
  readOnly,
  boundHeader,
  onNavigateUp,
  onReset,
  onOpenFile,
  activePath,
}: {
  session: Session;
  root: string;
  readOnly: boolean;
  /**
   * The sidebar's bound-worktree header, rendered INSIDE the provider so its
   * explorer utilities (Refresh · Collapse Folders) drive this tree — the same
   * arrangement files mode uses for the worktree.
   */
  boundHeader: ReactNode;
  onNavigateUp: () => void;
  onReset: () => void;
  /** Open `path` (relative to `root`) as an external editor tab. */
  onOpenFile: (path: string, opts?: { preview?: boolean }) => void;
  /** Path of the active editor tab when it is a file under this root. */
  activePath: string | null;
}) {
  return (
    // Keyed by root: walking up is a different tree, so its expansion,
    // selection, and any in-flight inline edit start fresh.
    <ExplorerProvider
      key={root}
      session={session}
      root={root}
      readOnly={readOnly}
      onOpenFile={(_sid, path, opts) => onOpenFile(path, opts)}
      activePath={activePath}
    >
      {boundHeader}
      <BrowseHeader root={root} onNavigateUp={onNavigateUp} onReset={onReset} />
      <div className="flex min-h-0 flex-1 flex-col">
        <FileExplorer />
      </div>
    </ExplorerProvider>
  );
}

/**
 * Where you are, and the two ways out. The path itself is part of the
 * walk-up control rather than inert text beside it: the whole line up to the
 * return button takes you up a level, so the gesture that got you here keeps
 * working without aiming at a 14px icon.
 */
function BrowseHeader({
  root,
  onNavigateUp,
  onReset,
}: {
  root: string;
  onNavigateUp: () => void;
  onReset: () => void;
}) {
  const home = useHostInfo().data?.home;
  return (
    <div className="flex h-8 shrink-0 items-center px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onNavigateUp}
            disabled={root === '/'}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-left text-fg-gold transition-colors hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          >
            <CornerLeftUp className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-mono text-xs text-fg-secondary">
              {tildify(root, home)}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{root === '/' ? root : 'Browse the parent directory'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onReset}
            className="ml-1 shrink-0 rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
          >
            <Undo2 className="size-3.5" />
            <span className="sr-only">Back to the worktree</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Back to the worktree</TooltipContent>
      </Tooltip>
    </div>
  );
}
