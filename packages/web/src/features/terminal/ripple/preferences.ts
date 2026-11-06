import { useSyncExternalStore } from 'react';
import { localValue } from '../../../lib/persistence/local-store';
import { useClientSettings } from '../../../lib/settings/client-settings';

// Placement ids stay on this host/browser and never enter portable settings sync.
const overrides = localValue('puddle.ripple.sessions');
const boundaries = localValue('puddle.ripple.boundaries');
const MAX_OVERRIDES = 256;

export function rippleOverrides(raw: string | null): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
        .slice(-MAX_OVERRIDES),
    );
  } catch {
    return {};
  }
}

export function setSessionRipple(session: string, enabled: boolean | null): void {
  const entries = Object.entries(rippleOverrides(overrides.get())).filter(([id]) => id !== session);
  if (enabled !== null) entries.push([session, enabled]);
  overrides.set(JSON.stringify(Object.fromEntries(entries.slice(-MAX_OVERRIDES))));
}

function subscribe(listener: () => void): () => void {
  const unsubscribe = overrides.subscribe(listener);
  window.addEventListener('storage', listener);
  return () => {
    unsubscribe();
    window.removeEventListener('storage', listener);
  };
}

export function useSessionRipple(session: string) {
  const settings = useClientSettings();
  const raw = useSyncExternalStore(subscribe, overrides.get);
  const values = rippleOverrides(raw);
  const override = Object.hasOwn(values, session) ? values[session]! : null;
  return { enabled: override ?? settings.rippleEnabled === true, override };
}

export function rippleBoundaries(raw: string | null): Record<string, number> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' &&
            Number.isInteger(entry[1]) &&
            entry[1] >= 1 &&
            entry[1] <= 500,
        )
        .slice(-MAX_OVERRIDES),
    );
  } catch {
    return {};
  }
}

export function setRippleBoundary(session: string, rows: number | null) {
  const entries = Object.entries(rippleBoundaries(boundaries.get())).filter(
    ([id]) => id !== session,
  );
  if (rows !== null) entries.push([session, Math.max(1, Math.min(500, Math.round(rows)))]);
  boundaries.set(JSON.stringify(Object.fromEntries(entries.slice(-MAX_OVERRIDES))));
}

export function useRippleBoundary(session: string) {
  const raw = useSyncExternalStore(boundaries.subscribe, boundaries.get);
  return rippleBoundaries(raw)[session] ?? null;
}
