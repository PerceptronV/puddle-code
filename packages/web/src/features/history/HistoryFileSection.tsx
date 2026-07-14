import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { DiffEntry } from '@puddle/shared';
import { cn } from '../../lib/utils';
import { diffStatusStyle } from '../diff/diff-status';
import { SECTION_MAX_HEIGHT } from '../diff/FileDiffSection';
import { HistoryFileContent } from './HistoryFileContent';
import { effectiveStatus } from './history-logic';

/**
 * One collapsible file within a commit's detail (SPEC §8, Task 9): the
 * header — status glyph, mono path (renames show `old → new`), a chevron —
 * toggles the body. Reuses the diff view's status glyph/colour presentation
 * (`diffStatusStyle`) but is otherwise its own, simpler component: no dirty
 * dot (nothing here is ever editable) and no IntersectionObserver mount-on-
 * visibility (a commit's file list is short; the body mounts as soon as the
 * section is expanded).
 */
export function HistoryFileSection({
  session,
  sha,
  entry,
  isRootCommit,
  defaultExpanded,
}: {
  session: string;
  sha: string;
  entry: DiffEntry;
  isRootCommit: boolean;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const style = diffStatusStyle(effectiveStatus(entry.status, isRootCommit));
  const label =
    entry.status === 'renamed' && entry.old_path ? `${entry.old_path} → ${entry.path}` : entry.path;

  return (
    <div className="bg-ground">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-elevated"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-fg-muted" />
        )}
        <span className={cn('w-3 shrink-0 font-mono text-xs', style.colourClass)}>
          {style.letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{label}</span>
      </button>
      {expanded && (
        <div style={{ height: SECTION_MAX_HEIGHT }} className="min-h-0">
          <HistoryFileContent
            session={session}
            sha={sha}
            entry={entry}
            isRootCommit={isRootCommit}
          />
        </div>
      )}
    </div>
  );
}
