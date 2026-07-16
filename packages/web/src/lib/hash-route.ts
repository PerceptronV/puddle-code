import { useEffect, useState } from 'react';

/**
 * Settings-dialog open state, with `#settings/<section>` deep links.
 *
 * The open action is PURE React state (a module-level setter set fanned out to
 * every consumer) so it re-renders the gate immediately. The URL is only a
 * MIRROR, written in an effect AFTER the opening render commits — never inside
 * the click handler. Setting `window.location.hash` in the handler was what
 * previously swallowed the open's own re-render (any later re-render then
 * revealed the dialog); keeping the URL write in an effect, via `replaceState`,
 * keeps it off that critical path and avoids a self-triggered `hashchange` loop.
 */
const setters = new Set<(section: string | null) => void>();

function parseSection(hash: string): string | null {
  const match = /^#settings\/([\w-]+)$/.exec(hash);
  return match ? match[1]! : null;
}

// Deep-link on first load: a URL that already carries #settings/<section> opens
// straight to it.
let current: string | null = parseSection(window.location.hash);

function emit(next: string | null): void {
  if (next === current) return;
  current = next;
  for (const set of setters) set(next);
}

// Back/forward and any external hash edit drive the state from the URL. Our own
// mirror uses replaceState (below), which fires neither event, so there's no loop.
window.addEventListener('hashchange', () => emit(parseSection(window.location.hash)));
window.addEventListener('popstate', () => emit(parseSection(window.location.hash)));

/** The open settings section, or null when the dialog is closed. */
export function useSettingsSection(): string | null {
  const [section, setSection] = useState(current);

  useEffect(() => {
    setSection(current); // catch a change between render and this effect
    setters.add(setSection);
    return () => {
      setters.delete(setSection);
    };
  }, []);

  // Mirror the section into the URL (deep link) — in an effect, so the write
  // lands after the render, off the open's critical path. Idempotent, so it's
  // fine that more than one consumer runs it.
  useEffect(() => {
    const want = section ? `#settings/${section}` : '';
    if (window.location.hash === want) return;
    history.replaceState(null, '', window.location.pathname + window.location.search + want);
  }, [section]);

  return section;
}

export function openSettings(next = 'appearance'): void {
  emit(next);
}

export function closeSettings(): void {
  emit(null);
}
