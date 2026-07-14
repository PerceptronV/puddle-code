import { useSyncExternalStore } from 'react';
import { localValue } from '../../lib/local-store';

/** The selected profile — identity, not auth (SPEC §11); remembered per browser. */
export const profileStore = localValue('puddle.profile-id');

export function useCurrentProfileId(): string | null {
  const raw = useSyncExternalStore(profileStore.subscribe, profileStore.get);
  // Pre-hex ids (integers) fail this and fall back to the picker.
  return raw !== null && /^[0-9a-f]{10}$/.test(raw) ? raw : null;
}

export function selectProfile(id: string): void {
  profileStore.set(id);
}
