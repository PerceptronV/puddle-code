import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { LayoutNode } from '@puddle/shared';
import { LazyTerminal } from '../terminal/LazyTerminal';
import { allLeaves } from './layout-tree';

/**
 * Terminal keep-alive for the tiling layout (SPEC §8), the one load-bearing
 * piece of the rewrite. A terminal's xterm + PTY attachment are bound to the
 * `Terminal` component's lifecycle, so moving it to a different React parent (a
 * different pane) would remount it and churn the attachment. Instead every open
 * terminal is rendered ONCE — via `createPortal` into a stable, manually-created
 * container `<div>` that lives in a hidden parking area — and a pane "adopts"
 * that container into its body with `appendChild` when the terminal is its
 * active tab. Moving the container relocates the DOM without React ever
 * reconciling a remount; React only manages the terminal's content INSIDE the
 * stable container, so its deletion always targets that container (never a
 * pane), sidestepping the adopt/unmount race a naive portal-with-changing-target
 * would hit. Do NOT "simplify" this to a portal whose target is a pane element.
 */

interface KeepAliveCtx {
  parkingRef: React.RefObject<HTMLDivElement | null>;
  containers: Map<string, HTMLDivElement>;
}

const Ctx = createContext<KeepAliveCtx | null>(null);

export function KeepAliveHost({
  tree,
  onOpenFile,
  children,
}: {
  tree: LayoutNode;
  onOpenFile: (session: string, path: string, line?: number, column?: number) => void;
  children: React.ReactNode;
}) {
  const parkingRef = useRef<HTMLDivElement>(null);
  const containers = useRef<Map<string, HTMLDivElement>>(new Map()).current;

  const sessions = useMemo(() => {
    const set = new Set<string>();
    for (const leaf of allLeaves(tree)) {
      for (const t of leaf.tabs) if (t.type === 'terminal') set.add(t.session);
    }
    return [...set];
  }, [tree]);

  // A stable container per open terminal, keyed by `term:<session>`. Created
  // detached; parented into the parking area (or left where a pane adopted it).
  const containerFor = (session: string): HTMLDivElement => {
    const key = `term:${session}`;
    let el = containers.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'size-full';
      containers.set(key, el);
    }
    return el;
  };

  useEffect(() => {
    const open = new Set(sessions.map((s) => `term:${s}`));
    for (const s of sessions) {
      const el = containers.get(`term:${s}`);
      if (el && !el.parentElement) parkingRef.current?.appendChild(el);
    }
    // Drop containers for terminals no longer open (their portal has already
    // unmounted its content; the container is now empty and safe to remove).
    for (const [key, el] of [...containers]) {
      if (!open.has(key)) {
        el.remove();
        containers.delete(key);
      }
    }
  }, [sessions, containers]);

  const ctx = useMemo<KeepAliveCtx>(() => ({ parkingRef, containers }), [containers]);

  return (
    <Ctx.Provider value={ctx}>
      <div ref={parkingRef} className="hidden" aria-hidden />
      {sessions.map((session) =>
        createPortal(
          <LazyTerminal
            stream={session}
            onOpenFile={(path, line, column) => onOpenFile(session, path, line, column)}
          />,
          containerFor(session),
          session,
        ),
      )}
      {children}
    </Ctx.Provider>
  );
}

/**
 * A ref for a pane's body slot: when `key` (a `tabRefKey`) names a kept-alive
 * terminal, its container is `appendChild`-ed into the slot; on change/unmount
 * the container returns to parking (still mounted). Returns a stable ref even
 * when `key` is null or names an editor (nothing is adopted then).
 */
export function useKeepAliveSlot(key: string | null): React.RefObject<HTMLDivElement | null> {
  const ctx = useContext(Ctx);
  const slotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = slotRef.current;
    if (!ctx || !key || !slot) return;
    const container = ctx.containers.get(key);
    if (container) slot.appendChild(container);
    return () => {
      const parking = ctx.parkingRef.current;
      if (container && parking && container.parentElement === slot) parking.appendChild(container);
    };
  }, [ctx, key]);
  return slotRef;
}
