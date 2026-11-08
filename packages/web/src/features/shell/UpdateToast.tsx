import { useEffect } from 'react';
import { toast } from 'sonner';
import { desktopBridge } from '../../lib/desktop';
import { useHostOffersOwner } from '../windows/effects/host-offers';

const TOAST_ID = 'desktop-update';
let offered: string | null = null;

/**
 * The desktop shell's update offer, as a dismissable toast (a permanent
 * bottom bar through v0.0.28 — jarring for something that demands nothing).
 * Pops when the shell has staged a release (downloaded and checksum-verified
 * — see the CLI lib's desktop-update); dismissing it parks the offer until
 * the next staged version or the next app launch. Restart uses the normal
 * application-wide checkpoint and recovery path.
 */
export function UpdateToast() {
  const owner = useHostOffersOwner('desktopOffers');
  useEffect(() => {
    if (owner === false) toast.dismiss(TOAST_ID);
  }, [owner]);
  return owner ? <OwnedUpdateToast /> : null;
}

function OwnedUpdateToast() {
  // The staged version already offered this launch: a dismissal must stand —
  // neither a re-render nor a repeat announcement may resurrect the toast.
  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge?.updateReady === undefined || bridge.onUpdateReady === undefined) return;

    let active = true;
    const offer = (version: string) => {
      if (!active || offered === version) return;
      offered = version;
      toast(`Puddle ${version} is downloaded and ready.`, {
        id: TOAST_ID,
        duration: Infinity,
        closeButton: true,
        action: {
          label: 'Restart to update',
          onClick: () => {
            desktopBridge()?.installUpdate?.();
            // A fresh id: sonner dismisses TOAST_ID itself after an action.
            toast.loading(`Restarting into Puddle ${version}…`, {
              id: `${TOAST_ID}-restarting`,
              duration: Infinity,
            });
          },
        },
      });
    };

    void bridge.updateReady().then((staged) => {
      if (staged !== null) offer(staged);
    });
    const off = bridge.onUpdateReady(offer);
    return () => {
      active = false;
      off();
    };
  }, []);

  return null;
}
