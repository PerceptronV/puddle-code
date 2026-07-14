import { useEffect, useMemo, useRef, useState } from 'react';
import { uiStateSnapshotSchema, type UiStateSnapshot } from '@puddle/shared';
import { debounce } from '../../lib/debounce';
import { fetchProjectState, putProjectState } from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';

const WRITE_DEBOUNCE_MS = 2000;

export interface UiStateHandle {
  /** False until the stored snapshot (or its absence) is known. */
  loaded: boolean;
  /** The restored snapshot; defaults when the project has none. */
  snapshot: UiStateSnapshot;
  /** Merge a change and schedule the debounced PUT (SPEC §11: ~2 s). */
  update(patch: Partial<UiStateSnapshot>): void;
}

const EMPTY: UiStateSnapshot = uiStateSnapshotSchema.parse({});

/** The per-window working-set key (SPEC §11: each window keeps its own). */
export function workingSetKey(projectId: string, profileId: string): string {
  return `puddle.ws.${projectId}.${profileId}`;
}

type StoredWorkingSet =
  { kind: 'present'; snapshot: UiStateSnapshot } | { kind: 'absent' } | { kind: 'corrupt' };

/**
 * Decides what a raw `sessionStorage.getItem(key)` result means — pure, so
 * it's testable without a DOM. `null` (nothing stored yet) is "absent" and
 * falls through to the server fetch; invalid JSON or a snapshot that fails
 * `uiStateSnapshotSchema` is "corrupt" (the caller clears the bad key and
 * also falls through); a value that parses and validates is "present" and
 * is used as-is, skipping the server fetch entirely.
 */
export function parseWorkingSet(raw: string | null): StoredWorkingSet {
  if (raw === null) return { kind: 'absent' };
  try {
    return { kind: 'present', snapshot: uiStateSnapshotSchema.parse(JSON.parse(raw)) };
  } catch {
    return { kind: 'corrupt' };
  }
}

/**
 * Two-tier persistence (SPEC §11 "Reload semantics"): each window keeps its
 * own working set in `sessionStorage` — reloading a window restores that
 * window exactly, and windows never live-sync while open. The
 * `(project, profile)` row on the server remains the seed for fresh
 * windows/browsers/machines and is updated debounced, last-writer-wins, by
 * whichever window changed layout most recently.
 *
 * Load order on `(projectId, profileId)` change: 1) `sessionStorage` — if
 * present and valid, restore it and skip the server fetch entirely; 2)
 * otherwise (absent, or corrupt and cleared) fetch the server snapshot as
 * before. `update` merges the patch, writes it to `sessionStorage`
 * synchronously, and schedules the same debounced server PUT as before.
 */
export function useUiState(projectId: string | undefined): UiStateHandle {
  const profileId = useCurrentProfileId();
  const [loaded, setLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<UiStateSnapshot>(EMPTY);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // The active sessionStorage key, if any — set alongside the effect below
  // so `update` can write synchronously without recomputing it every call.
  const keyRef = useRef<string | null>(null);

  const writer = useMemo(
    () =>
      debounce((pid: string, profile: string, state: UiStateSnapshot) => {
        putProjectState(pid, profile, state).catch((e) =>
          console.warn(`ui-state save failed: ${(e as Error).message}`),
        );
      }, WRITE_DEBOUNCE_MS),
    [],
  );

  useEffect(() => {
    if (projectId === undefined || profileId === null) {
      keyRef.current = null;
      return;
    }
    const key = workingSetKey(projectId, profileId);
    keyRef.current = key;
    let cancelled = false;
    setLoaded(false);
    setSnapshot(EMPTY);

    const stored = parseWorkingSet(sessionStorage.getItem(key));
    if (stored.kind === 'corrupt') sessionStorage.removeItem(key);

    if (stored.kind === 'present') {
      // This window's own working set beats the server row — no fetch.
      setSnapshot(stored.snapshot);
      setLoaded(true);
    } else {
      fetchProjectState(projectId, profileId)
        .then((state) => {
          if (cancelled) return;
          if (state) setSnapshot(state.ui_state);
          setLoaded(true);
        })
        .catch((e) => {
          console.warn(`ui-state load failed: ${(e as Error).message}`);
          if (!cancelled) setLoaded(true); // degrade to a fresh workspace
        });
    }

    return () => {
      cancelled = true;
      writer.flush(); // leaving the project — persist the last change now
    };
  }, [projectId, profileId, writer]);

  return {
    loaded,
    snapshot,
    update(patch) {
      if (projectId === undefined || profileId === null) return;
      const next = { ...snapshotRef.current, ...patch };
      snapshotRef.current = next;
      setSnapshot(next);
      const key = keyRef.current ?? workingSetKey(projectId, profileId);
      sessionStorage.setItem(key, JSON.stringify(next));
      writer(projectId, profileId, next);
    },
  };
}
