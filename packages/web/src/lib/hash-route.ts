import { useEffect, useState } from 'react';

/**
 * Settings-dialog open state. Deliberately NOT tied to `window.location.hash`
 * any more: setting the fragment inside the click handler was the culprit behind
 * "click settings does nothing, but any later re-render pops it up" — the open
 * never triggered its own render. This is now plain React state fanned out to
 * every consumer through a module-level setter set (a tiny pub-sub), so opening
 * re-renders the gate immediately like any other state change. No URL/# involved.
 */
const setters = new Set<(section: string | null) => void>();
let current: string | null = null;

function emit(next: string | null): void {
  current = next;
  for (const set of setters) set(next);
}

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
  return section;
}

export function openSettings(next = 'appearance'): void {
  emit(next);
}

export function closeSettings(): void {
  emit(null);
}
