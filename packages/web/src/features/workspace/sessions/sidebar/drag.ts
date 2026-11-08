import { useDroppable } from '@dnd-kit/core';
import { useEffect, useState, type DragEvent } from 'react';
import { ARCHIVE_DROP_PREFIX, useActiveDragRef } from '../../layout/TilingDnd';
import { decodeTabTransfer, hasTabTransfer, TAB_MIME } from '../../tabs/tab-transfer';
import { decodeSessionDrag, hasSessionDrag, SESSION_DRAG_MIME } from '../session-selection';

/** Give a multi-session drag an honest preview instead of showing one row. */
export function setCountDragImage(e: DragEvent, count: number) {
  const chip = document.createElement('div');
  chip.textContent = `${count} sessions`;
  chip.className = 'fixed -top-12 left-0 rounded-md bg-elevated px-2 py-1 text-xs text-fg';
  document.body.appendChild(chip);
  e.dataTransfer.setDragImage(chip, 12, 12);
  requestAnimationFrame(() => chip.remove());
}

/**
 * Archive-by-drag plumbing (SPEC §12): a session dragged onto an archive
 * target is archived. The sidebar's own rows and rail glyphs ride native HTML5
 * DnD (`TAB_MIME`, plus `SESSION_DRAG_MIME` for a selected batch), while centre
 * tab chips ride dnd-kit (a droppable under the workspace-wide `TilingDnd`
 * context, which routes the release via its `onArchive`). Editor payloads are
 * ignored — only a terminal ref names a session.
 */
export function useArchiveDrop(id: string, onArchiveDrop: (sessions: readonly string[]) => void) {
  const { isOver, setNodeRef } = useDroppable({ id: `${ARCHIVE_DROP_PREFIX}${id}` });
  const activeRef = useActiveDragRef();
  const [nativeOver, setNativeOver] = useState(false);
  // A drag that ends anywhere disarms the highlight: released over a pane or
  // cancelled with Esc, no `dragleave`/`drop` of ours fires (see PaneLeaf).
  useEffect(() => {
    const clear = () => setNativeOver(false);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);
  return {
    setNodeRef,
    /** Arm the highlight for either payload path. */
    armed: nativeOver || (isOver && activeRef !== null && activeRef.type !== 'editor'),
    props: {
      onDragOver: (e: DragEvent) => {
        if (!hasSessionDrag(e.dataTransfer.types) && !hasTabTransfer(e.dataTransfer.types)) return;
        e.preventDefault();
        setNativeOver(true);
      },
      onDragLeave: () => setNativeOver(false),
      onDrop: (e: DragEvent) => {
        setNativeOver(false);
        const sessions = decodeSessionDrag(e.dataTransfer.getData(SESSION_DRAG_MIME));
        if (sessions.length > 0) {
          e.preventDefault();
          onArchiveDrop(sessions);
          return;
        }
        const ref = decodeTabTransfer(e.dataTransfer.getData(TAB_MIME));
        if (!ref || ref.type === 'editor') return;
        e.preventDefault();
        onArchiveDrop([ref.session]);
      },
    },
  };
}
