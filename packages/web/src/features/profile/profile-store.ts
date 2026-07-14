import { useSyncExternalStore } from 'react';
import { localValue } from '../../lib/local-store';

/** The selected profile — identity, not auth (SPEC §11); remembered per browser. */
export const profileStore = localValue('puddle.profile-id');

export function useCurrentProfileId(): number | null {
  const raw = useSyncExternalStore(profileStore.subscribe, profileStore.get);
  const id = Number(raw);
  return raw !== null && Number.isInteger(id) && id > 0 ? id : null;
}

export function selectProfile(id: number): void {
  profileStore.set(String(id));
}
