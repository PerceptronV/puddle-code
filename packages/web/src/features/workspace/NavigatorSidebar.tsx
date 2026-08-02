import { useState } from 'react';
import {
  CornerLeftUp,
  GitBranch,
  FolderGit2,
  FolderTree,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { Session } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useDaemonVersion } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { ChangesNav } from '../changes/ChangesNav';
import { BrowseTree } from '../explorer/BrowseTree';
import { ExplorerProvider } from '../explorer/explorer-context';
import { parentDir } from '../explorer/explorer-paths';
import { FileExplorer } from '../explorer/FileExplorer';
import type { ExplorerTarget } from '../explorer/use-explorer-target';
import { SearchNav } from '../search/SearchNav';
import { WorktreesNav } from '../worktrees/WorktreesNav';
import { SidebarTargetHeader } from './SidebarTargetHeader';

export type SidebarMode = 'files' | 'changes' | 'search' | 'worktrees';

const MODES: { key: SidebarMode; label: string; icon: LucideIcon }[] = [
  { key: 'files', label: 'Files', icon: FolderTree },
  { key: 'search', label: 'Search', icon: Search },
  { key: 'changes', label: 'Changes', icon: GitBranch },
  { key: 'worktrees', label: 'Worktrees', icon: FolderGit2 },
];

/**
 * Maps a stored `sidebar_mode` onto a live navigator: the pre-unification
 * `diff`/`history` values both resolve to the merged `changes` view (SPEC §8),
 * so old snapshots keep working after the Diff+History unification.
 */
export function normalizeSidebarMode(mode: string): SidebarMode {
  if (mode === 'diff' || mode === 'history' || mode === 'changes') return 'changes';
  if (mode === 'search') return 'search';
  if (mode === 'worktrees') return 'worktrees';
  return 'files';
}

/**
 * The collapsed left navigator: a slim rail with the expand control on top
 * (mirroring the right sidebar, so the toggle stays visible when collapsed),
 * then the same mode icons — Files · Search · Changes — stacked vertically
 * (HUMANS.md minimalism, no border, a fill-shift on hover). The expand button
 * reopens to the last navigator; clicking a mode icon reopens straight to it
 * (SPEC §8).
 */
export function CollapsedSidebarRail({
  mode,
  onExpand,
  onSelect,
}: {
  mode: SidebarMode;
  onExpand: () => void;
  onSelect: (mode: SidebarMode) => void;
}) {
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center gap-1 bg-surface py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onExpand}
            className="flex items-center rounded-md p-1.5 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
          >
            <PanelLeftOpen className="size-4" />
            <span className="sr-only">Show sidebar</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Show sidebar</TooltipContent>
      </Tooltip>
      {MODES.map(({ key, label, icon: Icon }) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-current={mode === key ? 'page' : undefined}
              onClick={() => onSelect(key)}
              className={cn(
                'flex items-center rounded-md p-1.5 transition-colors',
                mode === key
                  ? 'bg-elevated text-fg'
                  : 'text-fg-gold hover:bg-elevated hover:text-fg',
              )}
            >
              <Icon className="size-4" />
              <span className="sr-only">{label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * The left sidebar (SPEC §8): a horizontal icon row — Files · Search · Changes
 * — with the collapse control on the right. The pin (which binds the whole
 * sidebar to one worktree) lives in the bound-worktree header below the row, to
 * keep this row uncluttered; every navigator (files tree, the unified
 * changes/graph view, and search) follows the bound worktree, and unpinning
 * resumes follow-the-active-session. Selections open their content as
 * centre-editor tabs, keeping the editor the single content surface.
 */
export function NavigatorSidebar({
  mode,
  onModeChange,
  onCollapse,
  projectId,
  repoId,
  sessions,
  target,
  onOpenFile,
  onOpenExternalFile,
  onOpenTerminalIn,
  activeFilePath,
  activeDiffPath,
  onOpenDiff,
  onOpenCommitFile,
  onOpenSearchFile,
}: {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  onCollapse: () => void;
  projectId: string;
  repoId: number;
  sessions: Session[];
  /** The worktree the whole sidebar is bound to, plus its pin controls. */
  target: ExplorerTarget;
  onOpenFile: (sessionId: string, path: string, opts?: { preview?: boolean }) => void;
  /** Spawn a terminal whose shell starts in this worktree-relative directory. */
  onOpenTerminalIn: (sessionId: string, dir: string) => void;
  /** Open an `external` editor tab: `path` is relative to the browse `root` (SPEC §8). */
  onOpenExternalFile: (
    sessionId: string,
    path: string,
    root: string,
    opts?: { preview?: boolean },
  ) => void;
  /** Path of the active editor tab when it is a file in the bound worktree — highlighted in the tree. */
  activeFilePath: string | null;
  /** Path of the active editor tab when it is an uncommitted diff for the bound worktree. */
  activeDiffPath: string | null;
  onOpenDiff: (path: string) => void;
  onOpenCommitFile: (path: string, sha: string) => void;
  onOpenSearchFile: (path: string, line?: number) => void;
}) {
  const { session } = target;

  // Parent-directory browsing (SPEC §8): navigating above the worktree swaps
  // the files tree for the BrowseTree, rooted here. Keyed to the session it was
  // opened for, so binding to a DIFFERENT session drops it; leaving the pin
  // drops it explicitly (see sidebarTarget below), since that is not a change
  // of session. Entering it PINS the sidebar, so follow-the-active-session
  // cannot yank the tree away mid-browse. Ephemeral local state on purpose — a
  // reload lands back on the worktree.
  const [browse, setBrowse] = useState<{ forSession: string; root: string } | null>(null);
  // `?root=` needs a 10.2+ daemon: an older one IGNORES the param and serves
  // worktree-relative paths as if they were the parent directory — silently
  // wrong data — so the whole browse entry point hides on version skew (the
  // same stance as folder drops gating on 9.2). Unknown (still fetching)
  // reads as supported; skew within a major is rare.
  const protocol = useDaemonVersion().data?.protocol;
  const browseSupported =
    !protocol || protocol.major > 10 || (protocol.major === 10 && protocol.minor >= 2);
  const browseRoot =
    browseSupported && browse !== null && browse.forSession === session?.id ? browse.root : null;
  const enterBrowse = (root: string) => {
    if (!session) return;
    if (!target.pinned) target.pin(session.id);
    setBrowse({ forSession: session.id, root });
  };

  // Unpinning leaves the browse too. The pin was applied BY entering the browse,
  // so releasing it has to hand the tree back — and keying the browse to a
  // session id alone could not do that, because unpinning usually does not
  // change which session is bound (it only changes how it is resolved), leaving
  // the tree stranded above the worktree while claiming to follow the active
  // tab. Every unpin path in this sidebar goes through the header, so wrapping
  // the target once here covers all of them.
  const sidebarTarget: ExplorerTarget = {
    ...target,
    unpin() {
      setBrowse(null);
      target.unpin();
    },
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-1 px-2 py-1.5">
        {MODES.map(({ key, label, icon: Icon }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-current={mode === key ? 'page' : undefined}
                onClick={() => onModeChange(key)}
                className={cn(
                  'flex items-center rounded-md p-1.5 transition-colors',
                  mode === key
                    ? 'bg-elevated text-fg'
                    : 'text-fg-gold hover:bg-elevated hover:text-fg',
                )}
              >
                <Icon className="size-4" />
                <span className="sr-only">{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCollapse}
              className="ml-auto flex items-center rounded-md p-1.5 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
            >
              <PanelLeftClose className="size-4" />
              <span className="sr-only">Hide sidebar</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Hide sidebar</TooltipContent>
        </Tooltip>
      </div>

      {/* The bound-worktree header applies to the worktree-scoped navigators;
          the Worktrees manager is repo-wide, so it has none. Files mode renders
          its own header INSIDE the ExplorerProvider (below) so the header's
          utility actions can drive the tree. */}
      {mode !== 'worktrees' && mode !== 'files' && (
        // Search names the absolute worktree path (like Files); Changes keeps the branch.
        <SidebarTargetHeader
          sessions={sessions}
          target={sidebarTarget}
          showPath={mode === 'search'}
        />
      )}

      {mode === 'worktrees' && (
        <WorktreesNav repoId={repoId} projectId={projectId} sessions={sessions} />
      )}

      {mode === 'files' &&
        (session && browseRoot !== null ? (
          // Browsing ABOVE the worktree, rooted at `browseRoot` (SPEC §8).
          // No ExplorerProvider — none of its tree machinery (mutations, git
          // status, selection) applies out here; files opened from it are
          // ordinary editors keyed by their browse root.
          <>
            <SidebarTargetHeader sessions={sessions} target={sidebarTarget} showPath />
            <BrowseTree
              sid={session.id}
              root={browseRoot}
              onNavigateUp={() => enterBrowse(parentDir(browseRoot))}
              onReset={() => setBrowse(null)}
              onOpenFile={(path, opts) => onOpenExternalFile(session.id, path, browseRoot, opts)}
            />
          </>
        ) : session ? (
          // The provider wraps both the header (its utility actions) and the
          // tree; FileExplorer's root is `h-full`, so its wrapper is a flex-1
          // min-h-0 column filling the space under the icon row + header.
          <ExplorerProvider
            session={session}
            onOpenFile={onOpenFile}
            onOpenTerminal={(dir) => onOpenTerminalIn(session.id, dir)}
            activePath={activeFilePath}
          >
            <SidebarTargetHeader
              sessions={sessions}
              target={sidebarTarget}
              showFileActions
              showPath
            />
            {/* The way OUT of the worktree: '..' enters the browse tree at
                the parent, pinning the sidebar so the bound session cannot
                change underneath the browse (SPEC §8). */}
            {browseSupported && (
              <button
                type="button"
                onClick={() => enterBrowse(parentDir(session.worktree_path))}
                title="Browse the parent directory"
                className="flex shrink-0 items-center gap-1.5 px-3 py-1 text-left transition-colors hover:bg-elevated"
              >
                <CornerLeftUp className="size-3 shrink-0 text-fg-gold" />
                <span className="font-mono text-xs text-fg-muted">..</span>
              </button>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              <FileExplorer />
            </div>
          </ExplorerProvider>
        ) : (
          <>
            <SidebarTargetHeader sessions={sessions} target={sidebarTarget} />
            <div className="px-3 py-2 text-xs text-fg-muted">No worktree to show.</div>
          </>
        ))}

      {mode === 'changes' &&
        (session ? (
          <ChangesNav
            key={session.id}
            session={session.id}
            activeDiffPath={activeDiffPath}
            onOpenDiff={onOpenDiff}
            onOpenCommitFile={onOpenCommitFile}
          />
        ) : (
          <div className="px-3 py-2 text-xs text-fg-muted">No worktree to show.</div>
        ))}

      {mode === 'search' &&
        (session ? (
          <SearchNav key={session.id} session={session.id} onOpen={onOpenSearchFile} />
        ) : (
          <div className="px-3 py-2 text-xs text-fg-muted">No worktree to search.</div>
        ))}
    </div>
  );
}
