import { useMemo, useSyncExternalStore } from 'react';
import { localValue } from '../../../lib/persistence/local-store';
import { useClientSettings } from '../../../lib/settings/client-settings';

// Placement ids stay on this host/browser and never enter portable settings sync.
const boundaries = localValue('puddle.ripple.boundaries');
const MAX_OVERRIDES = 256;

export function resetRippleBoundaries() {
  boundaries.set('{}');
}

export type RippleBoundaryPreference = 'cli' | number | { rows: number; inputOffset: number };

function validRows(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 500;
}
function validBoundary(value: unknown): value is RippleBoundaryPreference {
  if (value === 'cli' || validRows(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const { rows, inputOffset } = value as Record<string, unknown>;
  return (
    validRows(rows) &&
    typeof inputOffset === 'number' &&
    Number.isInteger(inputOffset) &&
    inputOffset >= -3 &&
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
  rows: number | 'cli' | null,
  inputRows: number | null = null,
) {
  const entries = Object.entries(rippleBoundaries(boundaries.get())).filter(
    ([id]) => id !== session,
  );
  if (rows !== null) {
    if (typeof rows === 'number') rows = Math.max(0, Math.min(500, Math.round(rows)));
    const preference =
      typeof rows === 'number' && rows > 0 && inputRows !== null && Math.abs(rows - inputRows) <= 3
        ? { rows, inputOffset: rows - inputRows }
        : rows;
    entries.push([session, preference]);
  }
  boundaries.set(JSON.stringify(Object.fromEntries(entries.slice(-MAX_OVERRIDES))));
}

export function useRippleBoundary(session: string) {
  const { rippleEnabled } = useClientSettings();
  const raw = useSyncExternalStore(boundaries.subscribe, boundaries.get);
  return useMemo(
    () => rippleBoundaries(raw)[session] ?? (rippleEnabled ? 0 : 'cli'),
    [raw, session, rippleEnabled],
  );
}
