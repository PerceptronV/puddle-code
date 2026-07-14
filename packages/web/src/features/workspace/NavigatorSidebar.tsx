import {
  GitBranch,
  FolderTree,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { Session } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { ChangesNav } from '../changes/ChangesNav';
import { FileExplorer } from '../explorer/FileExplorer';
import type { ExplorerTarget } from '../explorer/use-explorer-target';
import { SearchNav } from '../search/SearchNav';
import { SidebarTargetHeader } from './SidebarTargetHeader';

export type SidebarMode = 'files' | 'changes' | 'search';

const MODES: { key: SidebarMode; label: string; icon: LucideIcon }[] = [
  { key: 'files', label: 'Files', icon: FolderTree },
  { key: 'search', label: 'Search', icon: Search },
  { key: 'changes', label: 'Changes', icon: GitBranch },
];

/**
 * Maps a stored `sidebar_mode` onto a live navigator: the pre-unification
 * `diff`/`history` values both resolve to the merged `changes` view (SPEC §8),
 * so old snapshots keep working after the Diff+History unification.
 */
export function normalizeSidebarMode(mode: string): SidebarMode {
  if (mode === 'diff' || mode === 'history' || mode === 'changes') return 'changes';
  if (mode === 'search') return 'search';
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
            className="flex items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
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
                  : 'text-fg-muted hover:bg-elevated hover:text-fg',
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
 * — with the pin and collapse controls (both accent-blue) on the right. The pin
 * binds the whole sidebar to one worktree; every navigator (files tree, the
 * unified changes/graph view, and search) follows the bound worktree, and
 * unpinning resumes follow-the-active-session. Selections open their content as
 * centre-editor tabs, keeping the editor the single content surface.
 */
export function NavigatorSidebar({
  mode,
  onModeChange,
  onCollapse,
  sessions,
  target,
  onOpenFile,
  activeDiffPath,
  onOpenDiff,
  onOpenCommitFile,
  onOpenSearchFile,
}: {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  onCollapse: () => void;
  sessions: Session[];
  /** The worktree the whole sidebar is bound to, plus its pin controls. */
  target: ExplorerTarget;
  onOpenFile: (sessionId: string, path: string) => void;
  /** Path of the active editor tab when it is an uncommitted diff for the bound worktree. */
  activeDiffPath: string | null;
  onOpenDiff: (path: string) => void;
  onOpenCommitFile: (path: string, sha: string) => void;
  onOpenSearchFile: (path: string, line?: number) => void;
}) {
  const { session, pinned, pin, unpin } = target;

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
                    : 'text-fg-muted hover:bg-elevated hover:text-fg',
                )}
              >
                <Icon className="size-4" />
                <span className="sr-only">{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={pinned}
                disabled={!session}
                onClick={() => (pinned ? unpin() : session && pin(session.id))}
                className={cn(
                  'flex items-center rounded-md p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-40',
                  pinned ? 'bg-elevated text-fg' : 'text-fg-muted hover:bg-elevated hover:text-fg',
                )}
              >
                <Pin className={cn('size-4', pinned && 'fill-current')} />
                <span className="sr-only">{pinned ? 'Unpin sidebar' : 'Pin sidebar'}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {pinned ? 'Unpin — follow the active session' : 'Pin the sidebar to this worktree'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCollapse}
                className="flex items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
              >
                <PanelLeftClose className="size-4" />
                <span className="sr-only">Hide sidebar</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Hide sidebar</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <SidebarTargetHeader sessions={sessions} target={target} />

      {mode === 'files' &&
        (session ? (
          // FileExplorer's root is `h-full`, so it needs a flex-1 min-h-0
          // parent to fill the space left under the icon row + target header.
          <div className="flex min-h-0 flex-1 flex-col">
            <FileExplorer session={session} onOpenFile={onOpenFile} />
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-fg-muted">No worktree to show.</div>
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
