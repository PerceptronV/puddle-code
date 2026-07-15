import { createContext, useContext, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { TabRef } from '@puddle/shared';
import { zoneForPointer } from './layout-dnd';
import type { DropEdge, DropSpec } from './layout-tree';

/**
 * Drag-and-drop for the tiling layout (SPEC §8): dragging a tab out of its strip
 * over a pane resolves to a drop zone (centre → append, edge → split), shown as a
 * live highlight and committed on release. The zone is computed from the dragged
 * chip's centre against the hovered pane's measured rect (both provided by
 * dnd-kit), so no manual pointer tracking is needed.
 */

export interface DropIndicator {
  leafId: string;
  zone: DropEdge;
}

const IndicatorCtx = createContext<DropIndicator | null>(null);

/** The current drop indicator, for a pane to highlight its target zone. */
export function useDropIndicator(): DropIndicator | null {
  return useContext(IndicatorCtx);
}

const LEAF_PREFIX = 'leaf:';

export function TilingDnd({
  onDrop,
  renderOverlay,
  children,
}: {
  onDrop: (spec: DropSpec) => void;
  renderOverlay: (ref: TabRef) => React.ReactNode;
  children: React.ReactNode;
}) {
  // A small distance threshold so a click still activates a tab (not a drag).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [activeRef, setActiveRef] = useState<TabRef | null>(null);
  const latest = useRef<DropIndicator | null>(null);

  const clear = () => {
    setIndicator(null);
    setActiveRef(null);
    latest.current = null;
  };

  const onDragStart = (e: DragStartEvent) =>
    setActiveRef((e.active.data.current?.['ref'] as TabRef | undefined) ?? null);

  const onDragMove = (e: DragMoveEvent) => {
    const over = e.over;
    const dragged = e.active.rect.current.translated;
    if (!over || !dragged || !String(over.id).startsWith(LEAF_PREFIX)) {
      setIndicator(null);
      latest.current = null;
      return;
    }
    const r = over.rect;
    const cx = dragged.left + dragged.width / 2;
    const cy = dragged.top + dragged.height / 2;
    const zone = zoneForPointer(
      { width: r.width, height: r.height },
      { x: cx - r.left, y: cy - r.top },
    );
    const next: DropIndicator = { leafId: String(over.id).slice(LEAF_PREFIX.length), zone };
    latest.current = next;
    setIndicator(next);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const ind = latest.current;
    const ref = e.active.data.current?.['ref'] as TabRef | undefined;
    const fromLeafId = e.active.data.current?.['fromLeafId'] as string | undefined;
    clear();
    if (ind && ref && fromLeafId) {
      onDrop({ ref, fromLeafId, toLeafId: ind.leafId, edge: ind.zone });
    }
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={clear}
    >
      <IndicatorCtx.Provider value={indicator}>{children}</IndicatorCtx.Provider>
      <DragOverlay dropAnimation={null}>{activeRef ? renderOverlay(activeRef) : null}</DragOverlay>
    </DndContext>
  );
}
