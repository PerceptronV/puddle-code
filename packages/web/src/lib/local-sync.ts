import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authHeaders } from './api';

/**
 * Client for the cockpit's machine-shared sync store (SPEC §11, "Sync
 * locally"): GET/PUT /cockpit/local-sync, a JSON file under the CLIENT
 * machine's ~/.puddle that every puddle cockpit on the box serves. That is
 * what carries the selected settings groups across windows on DIFFERENT ports
 * (separate localStorage origins) and across daemons. Entries are keyed by
 * profile NAME, so "vincent" on one host syncs with "vincent" on another.
 * Unavailable (404 — e.g. the vite dev server, or an embedded cockpit) simply
 * hides the feature.
 */
export interface LocalSyncEntry {
  enabled: boolean;
  /** Selected group ids — applied to BOTH directions (import and export). */
  groups: string[];
  /** The mirrored export doc, `collectExport`'s shape. */
  doc: Record<string, Record<string, unknown>>;
  updatedAt: string;
}
export interface LocalSyncFile {
  version: 1;
  profiles: Record<string, LocalSyncEntry | undefined>;
}
export interface LocalSyncState {
  /** False when this cockpit has no store (dev server / embedded). */
  available: boolean;
  file: LocalSyncFile;
}

const EMPTY: LocalSyncFile = { version: 1, profiles: {} };

async function fetchLocalSync(): Promise<LocalSyncState> {
  try {
    const res = await fetch('/cockpit/local-sync', {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return { available: false, file: EMPTY };
    return { available: true, file: (await res.json()) as LocalSyncFile };
  } catch {
    return { available: false, file: EMPTY };
  }
}

/** The store's current contents; refetches on window focus so cross-window edits arrive. */
export function useLocalSync() {
  return useQuery({
    queryKey: ['local-sync'],
    queryFn: fetchLocalSync,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function usePutLocalSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { profile: string; entry: LocalSyncEntry }) => {
      const res = await fetch('/cockpit/local-sync', {
        method: 'PUT',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('The local sync store did not accept the write.');
      return (await res.json()) as LocalSyncFile;
    },
    onSuccess: (file) => qc.setQueryData<LocalSyncState>(['local-sync'], { available: true, file }),
  });
}
