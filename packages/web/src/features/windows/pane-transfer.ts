import type { DesktopWindowTransfersBridge, DesktopWorkspaceVersion } from '@puddle/shared';
import type { DesktopWorkingSet } from './working-set';
import { detachPaneContent } from './transfer-content';

/** No live model moves between renderers. Transfer its captured working set, then remount. */
export async function transferPane(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  projectId: string,
  paneId: string,
  fence: (active: boolean) => void,
): Promise<void> {
  if (!owner.loaded() || owner.locked()) throw new Error('The workspace is not ready to detach');
  const reference = { id: crypto.randomUUID(), profileId: owner.profileId };
  let captured: DesktopWorkspaceVersion | undefined;
  const adopt = async (version: DesktopWorkspaceVersion) => {
    if (owner.adopt(version, captured, projectId)) await owner.flush();
  };
  fence(true);
  try {
    captured = await owner.freeze();
    const content = detachPaneContent(captured.content, projectId, paneId);
    await bridge.preparePane({ ...reference, projectId, revision: captured.revision, ...content });
    if (!owner.matchesCapture(captured))
      throw new Error('The pane changed while opening its window; please try again');
    await adopt(await bridge.commit(reference));
  } catch (error) {
    // Adoption may already have retained a late draft. A subsequent disk error
    // must not replace that recovery copy with the older committed capture.
    if (!owner.locked()) throw error;
    const observed = await bridge.observe(reference).catch(() => null);
    if (observed?.status === 'committed' && observed.version) {
      await adopt(observed.version);
      return;
    }
    if (observed?.status === 'prepared') {
      const cancelled = await bridge.cancel(reference);
      if (cancelled.status === 'committed' && cancelled.version) {
        await adopt(cancelled.version);
        return;
      }
      if (cancelled.status !== 'cancelled')
        throw new Error('Could not confirm cancellation; the pane has been kept in place', {
          cause: error,
        });
    } else if (!observed) {
      throw new Error(
        'Could not confirm the transfer outcome; reload this window to recover its saved state',
        { cause: error },
      );
    }
    owner.resume();
    throw error;
  } finally {
    if (!owner.locked()) fence(false);
  }
}
