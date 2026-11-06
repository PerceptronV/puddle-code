import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { animateTabPlacement, trackNativePlacementSource } from './animate-placement';
import { animatePlacement } from '../../../lib/appearance/placement-motion';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { TabRef } from '@puddle/shared';
import { zoneForPointer } from './layout-dnd';
import type { DropEdge, DropSpec, PaneDropSpec } from './layout-tree';

/**
 * Drag-and-drop for the tiling layout (SPEC §8): dragging a tab over a pane
 * body resolves to a drop zone (centre → append, edge → split), while dragging
 * it along a TAB STRIP resolves to an insertion index (reorder / place-between),
 * both shown as a live highlight and committed on release. Both the collision
 * detection (`pointerWithin`) and the zone/side maths use the POINTER position
 * — one reference frame, so an off-centre grab of a wide chip cannot make the
 * hit target and the computed side disagree.
 */

export interface DropIndicator {
  leafId: string;
  zone: DropEdge;
  /**
   * Set when the drop is a strip insertion (hovering a tab or the strip's
   * tail): the visible index the caret is drawn at, and the `DropSpec.index`
   * committed on release. Absent for pane-body drops.
   */
  index?: number;
}

const IndicatorCtx = createContext<DropIndicator | null>(null);

/** The current drop indicator, for a pane to highlight its target zone. */
export function useDropIndicator(): DropIndicator | null {
  return useContext(IndicatorCtx);
}

const ActiveRefCtx = createContext<TabRef | null>(null);
const DraggingCtx = createContext(false);

export function useTilingDragging(): boolean {
  return useContext(DraggingCtx);
}

/**
 * The tab currently mid-drag (dnd-kit strip drags only), for targets outside
 * the panes — the sidebar's archive drop — to arm themselves by payload type.
 */
export function useActiveDragRef(): TabRef | null {
  return useContext(ActiveRefCtx);
}

const LEAF_PREFIX = 'leaf:';
const TAB_PREFIX = 'tabdrop:';
const STRIP_PREFIX = 'strip:';
/** Droppable-id prefix for the sidebar's archive targets (rail icon, list header). */
export const ARCHIVE_DROP_PREFIX = 'archive:';

/**
 * Tab chips and the strip's tail sit visually above the pane grid, so whichever
 * one the POINTER is inside wins outright (chips over their strip, strips over
 * everything); only outside them does the pane-body intersection apply.
 */
const collisions: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  // A whole pane released outside the grid stays put, even if its wide strip overlaps a target.
  if (args.active.data.current?.['paneId'] && within.length === 0) return [];
  for (const prefix of [TAB_PREFIX, STRIP_PREFIX]) {
    const hits = within.filter((c) => String(c.id).startsWith(prefix));
    if (hits.length > 0) return hits;
  }
  return within.length > 0 ? within : rectIntersection(args);
};

export function TilingDnd({
  onDrop,
  onDropPane,
  onArchive,
  renderOverlay,
  children,
}: {
  onDrop: (spec: DropSpec) => void;
  onDropPane?: (spec: PaneDropSpec) => void;
  /** A terminal tab released over an archive target (SPEC §12). */
  onArchive?: (session: string) => void;
  renderOverlay: (ref: TabRef) => React.ReactNode;
  children: React.ReactNode;
}) {
  // A small distance threshold so a click still activates a tab (not a drag).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [activeRef, setActiveRef] = useState<TabRef | null>(null);
  const [activePane, setActivePane] = useState<{ id: string; count: number } | null>(null);
  const latest = useRef<DropIndicator | null>(null);
  useEffect(trackNativePlacementSource, []);

  const clear = () => {
    setIndicator(null);
    setActiveRef(null);
    setActivePane(null);
    latest.current = null;
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveRef((e.active.data.current?.['ref'] as TabRef | undefined) ?? null);
    const paneId = e.active.data.current?.['paneId'] as string | undefined;
    setActivePane(
      paneId ? { id: paneId, count: e.active.data.current?.['tabCount'] as number } : null,
    );
  };

  const onDragMove = (e: DragMoveEvent) => {
    const over = e.over;
    const pointer = pointerPosition(e);
    let next =
      over && pointer
        ? resolveIndicator(String(over.id), over.rect, over.data.current, pointer)
        : null;
    const paneId = e.active.data.current?.['paneId'] as string | undefined;
    if (paneId && next) {
      next = next.leafId === paneId ? null : { leafId: next.leafId, zone: next.zone };
    }
    // Bail on no-change: a fresh object per pointermove would re-render every
    // strip (context subscribers) at mouse-move frequency for nothing.
    if (sameIndicator(latest.current, next)) return;
    latest.current = next;
    setIndicator(next);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const ind = latest.current;
    const ref = e.active.data.current?.['ref'] as TabRef | undefined;
    const fromLeafId = e.active.data.current?.['fromLeafId'] as string | undefined;
    const overId = e.over !== null ? String(e.over.id) : null;
    clear();
    const paneId = e.active.data.current?.['paneId'] as string | undefined;
    if (paneId) {
      if (ind && overId && !overId.startsWith(ARCHIVE_DROP_PREFIX)) {
        const source = document
          .querySelector<HTMLElement>(`[data-workspace-pane="${CSS.escape(paneId)}"]`)
          ?.getBoundingClientRect();
        animatePlacement(
          () => onDropPane?.({ fromLeafId: paneId, toLeafId: ind.leafId, edge: ind.zone }),
          source,
          () =>
            document.querySelector<HTMLElement>(`[data-workspace-pane="${CSS.escape(paneId)}"]`),
        );
      }
      return;
    }
    // Released over an archive target: archive the session instead of moving
    // the tab (editor tabs have no session to archive — ignored).
    if (overId !== null && overId.startsWith(ARCHIVE_DROP_PREFIX)) {
      if (ref?.type === 'terminal') onArchive?.(ref.session);
      return;
    }
    if (ind && ref && fromLeafId) {
      const initial = e.active.rect.current.initial;
      const source = initial
        ? new DOMRect(initial.left, initial.top, initial.width, initial.height)
        : undefined;
      animateTabPlacement(
        () => onDrop({ ref, fromLeafId, toLeafId: ind.leafId, edge: ind.zone, index: ind.index }),
        ref,
        ind.leafId,
        source,
      );
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisions}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={clear}
    >
      <IndicatorCtx.Provider value={indicator}>
        <DraggingCtx.Provider value={activeRef !== null || activePane !== null}>
          <ActiveRefCtx.Provider value={activeRef}>{children}</ActiveRefCtx.Provider>
        </DraggingCtx.Provider>
      </IndicatorCtx.Provider>
      <DragOverlay dropAnimation={null}>
        {activePane ? (
          <div className="rounded-md bg-elevated px-3 py-2 text-xs text-fg shadow-lg">
            Move pane · {activePane.count} {activePane.count === 1 ? 'tab' : 'tabs'}
          </div>
        ) : activeRef ? (
          renderOverlay(activeRef)
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * The pointer's viewport position mid-drag: the activator pointerdown plus the
 * accumulated delta. Null for non-pointer activations (defensive — the only
 * sensor here is PointerSensor).
 */
function pointerPosition(e: DragMoveEvent): { x: number; y: number } | null {
  const activator = e.activatorEvent as Partial<PointerEvent>;
  if (typeof activator.clientX !== 'number' || typeof activator.clientY !== 'number') return null;
  return { x: activator.clientX + e.delta.x, y: activator.clientY + e.delta.y };
}

function sameIndicator(a: DropIndicator | null, b: DropIndicator | null): boolean {
  if (a === null || b === null) return a === b;
  return a.leafId === b.leafId && a.zone === b.zone && a.index === b.index;
}

/** Map the hovered droppable (tab chip / strip tail / pane body) to an indicator. */
function resolveIndicator(
  overId: string,
  overRect: ClientRect,
  overData: Record<string, unknown> | undefined,
  pointer: { x: number; y: number },
): DropIndicator | null {
  if (overId.startsWith(TAB_PREFIX)) {
    const data = overData as { leafId: string; index: number } | undefined;
    if (!data) return null;
    // Left half of the chip → insert before it; right half → after.
    const after = pointer.x > overRect.left + overRect.width / 2;
    return { leafId: data.leafId, zone: 'center', index: data.index + (after ? 1 : 0) };
  }
  if (overId.startsWith(STRIP_PREFIX)) {
    const data = overData as { leafId: string; count: number } | undefined;
    return data ? { leafId: data.leafId, zone: 'center', index: data.count } : null;
  }
  if (overId.startsWith(LEAF_PREFIX)) {
    const zone = zoneForPointer(
      { width: overRect.width, height: overRect.height },
      { x: pointer.x - overRect.left, y: pointer.y - overRect.top },
    );
    return { leafId: overId.slice(LEAF_PREFIX.length), zone };
  }
  return null;
}
