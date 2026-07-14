import { useEffect, useMemo, useRef, useState } from 'react';
import { uiStateSnapshotSchema, type UiStateSnapshot } from '@puddle/shared';
import { debounce } from '../../lib/debounce';
import { fetchProjectState, putProjectState } from '../../lib/queries';

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

/**
 * Loads this client's workspace snapshot on project open (falling back to the
 * project's most recent one server-side) and writes changes back debounced.
 * Transient focus stays local to the window (SPEC §11).
 */
export function useUiState(projectId: number | undefined): UiStateHandle {
  const [loaded, setLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<UiStateSnapshot>(EMPTY);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const writer = useMemo(
    () =>
      debounce((pid: number, state: UiStateSnapshot) => {
        putProjectState(pid, state).catch((e) =>
          console.warn(`ui-state save failed: ${(e as Error).message}`),
        );
      }, WRITE_DEBOUNCE_MS),
    [],
  );

  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    setLoaded(false);
    setSnapshot(EMPTY);
    fetchProjectState(projectId)
      .then((state) => {
        if (cancelled) return;
        if (state) setSnapshot(state.ui_state);
        setLoaded(true);
      })
      .catch((e) => {
        console.warn(`ui-state load failed: ${(e as Error).message}`);
        if (!cancelled) setLoaded(true); // degrade to a fresh workspace
      });
    return () => {
      cancelled = true;
      writer.flush(); // leaving the project — persist the last change now
    };
  }, [projectId, writer]);

  return {
    loaded,
    snapshot,
    update(patch) {
      if (projectId === undefined) return;
      const next = { ...snapshotRef.current, ...patch };
      snapshotRef.current = next;
      setSnapshot(next);
      writer(projectId, next);
    },
  };
}
