import { useEffect, useState } from 'react';
import { desktopWindowEffectsStatusSchema } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';

/** Only the elected native renderer mounts the automatic host-update poller. */
export function useHostOffersOwner(
  kind: 'hostOffers' | 'desktopOffers' = 'hostOffers',
): boolean | null {
  const effects = desktopBridge()?.windows?.effects;
  const [owner, setOwner] = useState<boolean | null>(() => (effects ? null : true));
  useEffect(() => {
    if (!effects) return;
    let live = true;
    let changed = false;
    const receive = (value: unknown) => {
      const status = desktopWindowEffectsStatusSchema.safeParse(value);
      if (live && status.success) setOwner(status.data[kind]);
    };
    const off = effects.onChanged((status) => {
      changed = true;
      receive(status);
    });
    void effects
      .status()
      .then((status) => {
        if (!changed) receive(status);
      })
      .catch(() => {
        if (live && !changed) setOwner(false);
      });
    return () => {
      live = false;
      off();
    };
  }, [effects, kind]);
  return owner;
}
