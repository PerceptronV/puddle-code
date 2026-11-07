import { useMemo, useSyncExternalStore } from 'react';
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

export type RippleBoundaryPreference = number | { rows: number; inputOffset: number };

function validRows(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 500;
}
function validBoundary(value: unknown): value is RippleBoundaryPreference {
  if (validRows(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const { rows, inputOffset } = value as Record<string, unknown>;
  return (
    validRows(rows) &&
    typeof inputOffset === 'number' &&
    Number.isInteger(inputOffset) &&
    inputOffset >= 0 &&
    inputOffset <= 3
  );
}

export function rippleBoundaries(raw: string | null): Record<string, RippleBoundaryPreference> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, RippleBoundaryPreference] => validBoundary(entry[1]))
        .slice(-MAX_OVERRIDES),
    );
  } catch {
    return {};
  }
}

export function setRippleBoundary(
  session: string,
  rows: number | null,
  inputRows: number | null = null,
) {
  const entries = Object.entries(rippleBoundaries(boundaries.get())).filter(
    ([id]) => id !== session,
  );
  if (rows !== null) {
    rows = Math.max(1, Math.min(500, Math.round(rows)));
    const preference =
      inputRows !== null && Math.abs(rows - inputRows) <= 3
        ? { rows, inputOffset: Math.max(0, rows - inputRows) }
        : rows;
    entries.push([session, preference]);
  }
  boundaries.set(JSON.stringify(Object.fromEntries(entries.slice(-MAX_OVERRIDES))));
}

export function useRippleBoundary(session: string) {
  const raw = useSyncExternalStore(boundaries.subscribe, boundaries.get);
  return useMemo(() => rippleBoundaries(raw)[session] ?? null, [raw, session]);
}
