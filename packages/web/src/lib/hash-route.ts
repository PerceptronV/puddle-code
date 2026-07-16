import { useSyncExternalStore } from 'react';

/**
 * The settings dialog is route-addressable as `#settings/<section>` so ⌘K,
 * deep links, and the gear icon all share one mechanism (plan §E).
 */
const listeners = new Set<() => void>();
let attached = false;

function subscribe(listener: () => void): () => void {
  if (!attached) {
    window.addEventListener('hashchange', () => {
      for (const l of listeners) l();
    });
    attached = true;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Set the fragment AND notify subscribers. A bare `location.hash = …` fires a
 * `hashchange` event only when the value actually changes — assigning the
 * current value (e.g. reopening the same settings section) emits nothing, so the
 * `useSyncExternalStore` store never re-renders and the dialog silently fails to
 * open until a reload. Notifying unconditionally closes that gap (the same way
 * `closeSettings` compensates for `replaceState` firing no event).
 */
export function setHash(hash: string): void {
  window.location.hash = hash;
  notify();
}

export function openSettings(section = 'appearance'): void {
  setHash(`settings/${section}`);
}

export function closeSettings(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
  notify(); // replaceState fires no hashchange
}

export function settingsSection(hash: string): string | null {
  const match = /^#settings\/([\w-]+)$/.exec(hash);
  return match ? match[1]! : null;
}
