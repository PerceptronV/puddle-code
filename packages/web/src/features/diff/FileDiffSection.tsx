import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, Circle } from 'lucide-react';
import type { DiffEntry } from '@puddle/shared';
import { cn } from '../../lib/utils';
import { bufferKey, isDirty, subscribe } from '../editor/buffer-store';
import { diffStatusStyle } from './diff-status';
import { FileDiffContent } from './FileDiffContent';

/** Fixed height each section's Monaco content occupies (internal scroll). */
export const SECTION_MAX_HEIGHT = 400;

/** Reactive dirty flag for one (session, path) buffer — mirrors EditorTabStrip. */
function useDirty(key: string): boolean {
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(key, cb), [key]),
    () => isDirty(key),
  );
}

/**
 * One collapsible file in the diff view (SPEC §8). The header — status glyph,
 * mono path (renames show `old → new`), a dirty dot, a chevron — toggles the
 * body; sections past the first few open collapsed (see `defaultExpanded`).
 *
 * The body's Monaco instance is doubly lazy: it mounts only once the section
 * first scrolls into view AND is expanded, so a large diff never spins up dozens
 * of editors at once. Until then a fixed-height placeholder holds the space.
 */
export function FileDiffSection({
  session,
  against,
  entry,
  defaultExpanded,
}: {
  session: string;
  against: string;
  entry: DiffEntry;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const style = diffStatusStyle(entry.status);
  const key = bufferKey(session, entry.path);
  const dirty = useDirty(key);

  // Mount-on-visibility: observe the section root once, then disconnect. A
  // small rootMargin mounts editors just before they scroll fully into view.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const shouldMount = visible && expanded;
  const label =
    entry.status === 'renamed' && entry.old_path ? `${entry.old_path} → ${entry.path}` : entry.path;

  return (
    <div ref={rootRef} className="bg-ground">
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
        <span className="truncate font-mono text-xs text-fg">{label}</span>
        {dirty && (
          <Circle
            className="size-2 shrink-0 fill-current text-fg-secondary"
            aria-label="unsaved changes"
          />
        )}
      </button>
      {expanded && (
        <div style={{ height: SECTION_MAX_HEIGHT }} className="min-h-0">
          {shouldMount ? (
            <FileDiffContent session={session} against={against} entry={entry} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-fg-muted">…</div>
          )}
        </div>
      )}
    </div>
  );
}
