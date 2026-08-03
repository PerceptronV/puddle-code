import { useSyncExternalStore } from 'react';
import type { LayoutNode, LayoutScope, SavedLayout } from '@puddle/shared';

/**
 * Cross-feature plumbing for the top-bar Layouts popover (SPEC §11), the same
 * shape as `scratchpad-store`:
 *
 *  - the popover's open flag lives here so the `layouts.toggle` hotkey can
 *    flip it from anywhere;
 *  - the mounted workspace registers a bridge describing the LIVE layout
 *    (scope, signature, the saved layout it derives from) plus the capture and
 *    apply operations — the popover renders through it without a second
 *    `useUiState` handle ever existing (two would race the debounced writer).
 */

/**
 * What the popover renders and loads through. The mounted workspace registers
 * one here; without a workspace the popover falls back to the dashboard
 * bridge (`useDashboardLayouts`), which drives the persisted snapshot
 * directly — the same shape either way.
 */
export interface LayoutBridge {
  /** The scope a save captures right now (the client setting at this moment). */
  scope: LayoutScope;
  /** The project the workspace is open on (a project-scoped save binds to it). */
  projectId: string;
  /** Saved-layout id the live layout was loaded from / saved as; null = unnamed. */
  layoutRef: number | null;
  /** `layoutSignature` of the live scoped tree, for dirty comparison. */
  signature: string;
  /**
   * True when there is no single live layout to describe — the dashboard
   * under project-based layout, where every project keeps its own. The
   * popover hides the head (nothing to name or save); loads still work.
   */
  headless?: boolean;
  /**
   * Per-project slice state, reported by a headless bridge so the popover can
   * mark the current layout and confirm before a load discards a slice's
   * unsaved changes. Keyed by project id.
   */
  slices?: Record<string, { layoutRef: number | null; signature: string }>;
  /** The live scoped slice, as a saved layout would store it. */
  capture(): { layout_tree: LayoutNode | null; active_session: string | null };
  /**
   * Load a saved layout into the live state, switching the
   * project-based-layout setting (with the union/shard transition suppressed)
   * when the layout's scope disagrees with it. False: not ready yet (data
   * still loading).
   */
  apply(layout: SavedLayout): boolean;
}

const listeners = new Set<() => void>();
let open = false;
let bridge: LayoutBridge | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLayoutsOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  notify();
}
export function toggleLayouts(): void {
  setLayoutsOpen(!open);
}
export function useLayoutsOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

export function setLayoutBridge(next: LayoutBridge | null): void {
  bridge = next;
  notify();
}
export function useLayoutBridge(): LayoutBridge | null {
  return useSyncExternalStore(subscribe, () => bridge);
}
