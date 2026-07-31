import { useQuery } from '@tanstack/react-query';
import type {
  CreateUntitledResponse,
  PutUntitledResponse,
  UntitledFileResponse,
} from '@puddle/shared';
import { api } from './api';

/**
 * Untitled drafts (protocol 10.3, SPEC §8): worktree-agnostic scratch files
 * in the profile's `untitled/` store. Created by a blank-strip double-click,
 * persisted continuously while edited, and deleted when saved into a worktree
 * or discarded with their tab.
 */

export function createUntitled(profileId: string): Promise<CreateUntitledResponse> {
  return api<CreateUntitledResponse>('POST', `/api/profiles/${profileId}/untitled`);
}

export function useUntitledFile(profileId: string | null, name: string) {
  return useQuery({
    queryKey: ['untitled', profileId, name],
    queryFn: () => api<UntitledFileResponse>('GET', `/api/profiles/${profileId}/untitled/${name}`),
    enabled: profileId !== null,
    // The open tab's model is the source of truth while editing; never let a
    // background refetch fight the debounced persistence writes.
    staleTime: Infinity,
  });
}

export function putUntitled(
  profileId: string,
  name: string,
  content: string,
): Promise<PutUntitledResponse> {
  return api<PutUntitledResponse>('PUT', `/api/profiles/${profileId}/untitled/${name}`, {
    content,
  });
}

export function deleteUntitled(profileId: string, name: string): Promise<void> {
  return api<void>('DELETE', `/api/profiles/${profileId}/untitled/${name}`);
}
