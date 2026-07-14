import {
  FileDiff,
  FolderTree,
  History as HistoryIcon,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';
import type { Session } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { DiffNav } from '../diff/DiffNav';
import { ExplorerHeader } from '../explorer/ExplorerHeader';
import { FileExplorer } from '../explorer/FileExplorer';
import type { ExplorerTarget } from '../explorer/use-explorer-target';
import { HistoryNav } from '../history/HistoryNav';

export type SidebarMode = 'files' | 'diff' | 'history';

/**
 * The collapsed left navigator: a slim rail holding just the expand control,
 * so the editor and terminals get the full width (HUMANS.md minimalism — no
 * border, a fill-shift on hover). Clicking restores the sidebar to its last mode.
 */
export function CollapsedSidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="flex h-full w-9 shrink-0 flex-col items-center bg-surface py-1.5">
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
        <TooltipContent>Show sidebar</TooltipContent>
      </Tooltip>
    </div>
  );
}

const MODES: { key: SidebarMode; label: string; icon: LucideIcon }[] = [
  { key: 'files', label: 'Files', icon: FolderTree },
  { key: 'diff', label: 'Diff', icon: FileDiff },
  { key: 'history', label: 'History', icon: HistoryIcon },
];

/**
 * The left sidebar (SPEC §8): a horizontal icon row — Files · Diff · History —
 * over the selected navigator. Files keeps its own pin (via `ExplorerHeader`);
 * Diff and History follow the active agent's worktree. Every navigator is a
 * list — selections open their content as centre-editor tabs, so the editor
 * stays the single content surface. Active mode is a fill shift, never a
 * border (HUMANS.md).
 */
export function NavigatorSidebar({
  mode,
  onModeChange,
  onCollapse,
  sessions,
  filesTarget,
  onOpenFile,
  activeSession,
  activeDiffPath,
  onOpenDiff,
  onOpenCommitFile,
}: {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  onCollapse: () => void;
  sessions: Session[];
  filesTarget: ExplorerTarget;
  onOpenFile: (sessionId: string, path: string) => void;
  activeSession: Session | null;
  /** Path of the active editor tab when it is a diff for `activeSession` — highlighted in the Diff list. */
  activeDiffPath: string | null;
  onOpenDiff: (path: string) => void;
  onOpenCommitFile: (path: string, sha: string) => void;
}) {
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCollapse}
              className="ml-auto flex items-center rounded-md p-1.5 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
            >
              <PanelLeftClose className="size-4" />
              <span className="sr-only">Hide sidebar</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Hide sidebar</TooltipContent>
        </Tooltip>
      </div>

      {mode === 'files' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ExplorerHeader sessions={sessions} target={filesTarget} />
          {filesTarget.session ? (
            <FileExplorer session={filesTarget.session} onOpenFile={onOpenFile} />
          ) : (
            <div className="px-3 py-2 text-xs text-fg-muted">No worktree to show.</div>
          )}
        </div>
      )}

      {mode === 'diff' &&
        (activeSession ? (
          <DiffNav
            key={activeSession.id}
            session={activeSession.id}
            activePath={activeDiffPath}
            onOpen={onOpenDiff}
          />
        ) : (
          <div className="px-3 py-2 text-xs text-fg-muted">No active session.</div>
        ))}

      {mode === 'history' &&
        (activeSession ? (
          <HistoryNav key={activeSession.id} session={activeSession.id} onOpen={onOpenCommitFile} />
        ) : (
          <div className="px-3 py-2 text-xs text-fg-muted">No active session.</div>
        ))}
    </div>
  );
}
