import { useEffect } from 'react';
import { desktopBridge } from '../../lib/desktop';
import { toastError } from '../../lib/transport/errors';
import { desktopWindowContext } from './window-context';
import { desktopWorkingSet } from './use-desktop-state';
import { fenceWindowInteraction } from './interaction-fence';
import { transferPane } from './pane-transfer';

export async function openPaneWindow(
  profileId: string,
  projectId: string,
  paneId: string,
): Promise<void> {
  const bridge = desktopBridge()?.windows?.transfers;
  const owner = desktopWorkingSet(profileId);
  if (!bridge || !owner) throw new Error('Native pane windows are unavailable');
  await transferPane(owner, bridge, projectId, paneId, fenceWindowInteraction);
}

let accepting: Promise<void> | null = null;
/** A staged destination accepts only after the ordinary workspace has mounted its content chunks. */
export function useAcceptWindowTransfer(profileId: string | undefined, ready: boolean): void {
  useEffect(() => {
    const context = desktopWindowContext();
    const bridge = desktopBridge()?.windows?.transfers;
    if (!profileId || !ready || !context?.stagingTransfer || !bridge || accepting) return;
    const owner = desktopWorkingSet(profileId);
    if (!owner?.loaded()) return;
    accepting = bridge.accept({ id: context.stagingTransfer, profileId }).then((version) => {
      owner.adopt(version);
      delete context.stagingTransfer;
      fenceWindowInteraction(false);
    });
    void accepting.catch(toastError);
  }, [profileId, ready]);
}
