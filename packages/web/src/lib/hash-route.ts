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

export function openSettings(section = 'appearance'): void {
  window.location.hash = `settings/${section}`;
}

export function closeSettings(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
  for (const l of listeners) l(); // replaceState fires no hashchange
}

export function settingsSection(hash: string): string | null {
  const match = /^#settings\/([\w-]+)$/.exec(hash);
  return match ? match[1]! : null;
}
