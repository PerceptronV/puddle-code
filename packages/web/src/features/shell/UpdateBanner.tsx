import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { desktopBridge } from '../../lib/desktop';

/**
 * The desktop shell's update offer, styled after ConnectionBanner (its
 * bottom-anchored sibling in ShellLayout). Renders nothing outside the shell
 * or while the app is current; when the shell has staged a release
 * (downloaded and checksum-verified — see the CLI lib's desktop-update), one
 * click restarts into it. Never interrupts: sessions live in the daemon, so
 * the restart only replaces this window.
 */
export function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge?.updateReady === undefined || bridge.onUpdateReady === undefined) return;
    void bridge.updateReady().then((staged) => {
      if (staged !== null) setVersion(staged);
    });
    return bridge.onUpdateReady(setVersion);
  }, []);

  if (version === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 bg-elevated px-3 py-2">
      <span className="text-xs text-fg-secondary">
        {restarting
          ? `Restarting into Puddle ${version}…`
          : `Puddle ${version} is downloaded and ready.`}
      </span>
      {!restarting && (
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => {
            setRestarting(true);
            desktopBridge()?.installUpdate?.();
          }}
        >
          <RefreshCw />
          Restart to update
        </Button>
      )}
    </div>
  );
}
