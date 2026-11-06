import { useSyncExternalStore } from 'react';
import { localValue } from '../../../lib/persistence/local-store';
import { useClientSettings } from '../../../lib/settings/client-settings';

// Placement ids stay on this host/browser and never enter portable settings sync.
const overrides = localValue('puddle.ripple.sessions');
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
