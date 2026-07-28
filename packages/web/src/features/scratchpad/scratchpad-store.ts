import { useSyncExternalStore } from 'react';

/**
 * Cross-feature plumbing for the top-bar Scratchpad popover (SPEC §11):
 *
 *  - the workspace registers its focused-terminal insert action here, so the
 *    shell-level popover can paste an entry without prop-drilling through the
 *    router (the same idea as `new-session-context`, as a module store because
 *    the global hotkey also needs to reach it);
 *  - the popover's open flag lives here so the `scratchpad.toggle` hotkey and
 *    any future callers can flip it from anywhere.
 */
const listeners = new Set<() => void>();
let open = false;
let insertHandler: ((text: string) => void) | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setScratchpadOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  notify();
}
export function toggleScratchpad(): void {
  setScratchpadOpen(!open);
}
export function useScratchpadOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

/** The workspace's bracketed-paste insert; null while no workspace is mounted. */
export function setScratchpadInsertHandler(handler: ((text: string) => void) | null): void {
  insertHandler = handler;
  notify();
}
export function useScratchpadInsertHandler(): ((text: string) => void) | null {
  return useSyncExternalStore(subscribe, () => insertHandler);
}
