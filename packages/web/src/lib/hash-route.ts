import { useEffect, useState } from 'react';

/**
 * Settings-dialog routing. The open section is a plain module variable — the
 * source of truth — mirrored into the URL as `#settings/<section>` for deep
 * links, and resynced from the hash on back/forward.
 *
 * Consumers subscribe with `useState`/`useEffect` rather than
 * `useSyncExternalStore`: the latter did NOT re-render the gate on a
 * programmatic open in this app (the dialog only appeared after a reload, which
 * reads the section straight from the URL at first render). A `useState`
 * setter driven by our own listener set is the reliable path.
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

// Back/forward and any external hash edit change the fragment out of band; keep
// the module `section` (and every subscriber) in sync with the URL.
function resyncFromHash(): void {
  section = parseSection(window.location.hash);
  notify();
}
window.addEventListener('hashchange', resyncFromHash);
window.addEventListener('popstate', resyncFromHash);

/** The open settings section, or null when the dialog is closed. */
export function useSettingsSection(): string | null {
  const [value, setValue] = useState(section);
  useEffect(() => {
    setValue(section); // catch a change between render and this effect
    const listener = () => setValue(section);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
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
