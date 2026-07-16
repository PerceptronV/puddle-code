import { useSyncExternalStore } from 'react';

/**
 * Settings-dialog routing. The open section is a CONTROLLED module store — the
 * source of truth — NOT `window.location.hash` read live. Reading the hash was
 * unreliable: assigning the value it already holds fires no `hashchange` (so
 * reopening a section did nothing until reload), and react-router's `pushState`
 * can clear the fragment out from under us with no event at all (so the dialog
 * would silently fail to open or close). We keep the URL `#settings/<section>`
 * as a deep-link MIRROR and resync from it only on the events that DO fire
 * (back/forward, an external hash edit).
 */
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

function parseSection(hash: string): string | null {
  const match = /^#settings\/([\w-]+)$/.exec(hash);
  return match ? match[1]! : null;
}

let section: string | null = parseSection(window.location.hash);
let attached = false;

function subscribe(listener: () => void): () => void {
  if (!attached) {
    // Back/forward and deep links change the hash out-of-band → resync from it.
    const resync = () => {
      section = parseSection(window.location.hash);
      notify();
    };
    window.addEventListener('hashchange', resync);
    window.addEventListener('popstate', resync);
    attached = true;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open settings section, or null when the dialog is closed. */
export function useSettingsSection(): string | null {
  return useSyncExternalStore(subscribe, () => section);
}

export function openSettings(next = 'appearance'): void {
  section = next;
  // Mirror into the URL for deep-linking; the guard avoids a redundant event.
  if (window.location.hash !== `#settings/${next}`) {
    window.location.hash = `settings/${next}`;
  }
  notify();
}

export function closeSettings(): void {
  section = null;
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  notify();
}
