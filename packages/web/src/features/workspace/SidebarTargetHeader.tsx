import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  Pin,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import type { Session } from '@puddle/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { sessionDisplayName } from '../../lib/session-display';
import { cn } from '../../lib/utils';
import { useExplorerOptional } from '../explorer/explorer-context';
import type { ExplorerTarget } from '../explorer/use-explorer-target';

/**
 * The left sidebar's bound-worktree header (SPEC §8), shown under the icon row
 * for every navigator (Files, Changes, Search): it names the bound worktree's
 * branch, carries the pin toggle, and offers a dropdown to pin any other project
 * worktree by hand. In files mode (`showFileActions`) it also hosts the explorer
 * utility cluster — New File · New Folder · Refresh · Collapse Folders — and
 * turns the branch title into a hover-marquee that eases its content leftwards
 * to reveal the tail the icons occlude.
 */
export function SidebarTargetHeader({
  sessions,
  target,
  showFileActions = false,
}: {
  sessions: Session[];
  target: ExplorerTarget;
  showFileActions?: boolean;
}) {
  const { session, pinned, pin, unpin } = target;
  const pickable = sessions.filter((s) => s.status !== 'archived');
  const branchLabel = session ? session.branch || sessionDisplayName(session) : 'No worktree';

  return (
    <div className="group flex h-8 shrink-0 items-center gap-1 px-2">
      <MarqueeTitle text={branchLabel} />
      {showFileActions && session && <ExplorerActions />}
      <button
        type="button"
        aria-pressed={pinned}
        disabled={!session}
        title={pinned ? 'Unpin — follow the active session' : 'Pin the sidebar to this worktree'}
        onClick={() => (pinned ? unpin() : session && pin(session.id))}
        className={cn(
          'shrink-0 rounded-sm p-1 transition-colors disabled:pointer-events-none disabled:opacity-40',
          pinned ? 'text-fg' : 'text-fg-muted hover:bg-elevated hover:text-fg',
        )}
      >
        <Pin className={cn('size-3.5', pinned && 'fill-current')} />
        <span className="sr-only">{pinned ? 'Unpin sidebar' : 'Pin sidebar'}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Bind a different worktree"
            className="shrink-0 rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <ChevronDown className="size-3.5" />
            <span className="sr-only">Choose a worktree</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {pickable.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-fg-muted">No sessions yet</div>
          ) : (
            pickable.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => pin(s.id)}>
                <span className="truncate font-mono">
                  {s.branch} — {sessionDisplayName(s)}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The branch title as a hover-marquee: clipped at rest, easing to reveal its tail on header hover. */
function MarqueeTitle({ text }: { text: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    const measure = () => setOverflow(Math.max(0, el.scrollWidth - el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  // The tail offset applied on header hover only when the title actually
  // overflows; the transition eases it back out on leave.
  return (
    <div className="min-w-0 flex-1 overflow-hidden">
      <span
        ref={spanRef}
        className={cn(
          'block whitespace-nowrap font-mono text-xs text-fg-secondary transition-transform duration-[900ms] ease-linear',
          overflow > 0 && 'group-hover:[transform:translateX(var(--tail))]',
        )}
        style={overflow > 0 ? ({ '--tail': `-${overflow}px` } as React.CSSProperties) : undefined}
      >
        {text}
      </span>
    </div>
  );
}

const ACTIONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: 'new-file', label: 'New File', icon: FilePlus },
  { key: 'new-folder', label: 'New Folder', icon: FolderPlus },
  { key: 'refresh', label: 'Refresh', icon: RefreshCw },
  { key: 'collapse', label: 'Collapse Folders', icon: ChevronsDownUp },
];

/** The explorer utility cluster, revealed on header hover (HUMANS.md: no borders, fill-shift). */
function ExplorerActions() {
  const ex = useExplorerOptional();
  if (!ex) return null;
  const run = (key: string) => {
    if (key === 'new-file') ex.beginCreate('', 'file');
    else if (key === 'new-folder') ex.beginCreate('', 'dir');
    else if (key === 'refresh') ex.refresh();
    else if (key === 'collapse') ex.collapseAll();
  };
  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      {ACTIONS.map(({ key, label, icon: Icon }) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => run(key)}
              className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
            >
              <Icon className="size-3.5" />
              <span className="sr-only">{label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
