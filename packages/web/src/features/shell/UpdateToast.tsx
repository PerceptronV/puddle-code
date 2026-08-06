import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { desktopBridge } from '../../lib/desktop';

const TOAST_ID = 'desktop-update';

/**
 * The desktop shell's update offer, as a dismissable toast (a permanent
 * bottom bar through v0.0.28 — jarring for something that demands nothing).
 * Pops when the shell has staged a release (downloaded and checksum-verified
 * — see the CLI lib's desktop-update); dismissing it parks the offer until
 * the next staged version or the next app launch. Never interrupts: sessions
 * live in the daemon, so the restart only replaces this window.
 */
export function UpdateToast() {
  // The staged version already offered this launch: a dismissal must stand —
  // neither a re-render nor a repeat announcement may resurrect the toast.
  const offered = useRef<string | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge?.updateReady === undefined || bridge.onUpdateReady === undefined) return;

    const offer = (version: string) => {
      if (offered.current === version) return;
      offered.current = version;
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
    return bridge.onUpdateReady(offer);
  }, []);

  return null;
}
