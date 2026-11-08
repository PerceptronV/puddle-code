import { useEffect } from 'react';
import { arrangementParticipant } from '../use-desktop-state';

/** Native layouts accept the same mounted presentation used for ordinary work. */
export function useArrangementReady(profileId: string | null | undefined, ready: boolean): void {
  useEffect(() => {
    if (profileId && ready) arrangementParticipant.mounted(profileId);
  }, [profileId, ready]);
}
