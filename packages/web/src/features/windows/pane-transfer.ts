import type {
  DesktopWindowTransfersBridge,
  DesktopWorkspaceVersion,
  DesktopWorkspaceContent,
  TabRef,
  DesktopTransferReference,
  DesktopPaneDock,
  DesktopTabDock,
  DesktopWindowProjectsBridge,
} from '@puddle/shared';
import type { DesktopWorkingSet } from './working-set';
import { detachPaneContent, detachTabContent } from './transfer-content';
import { flattenTabs } from '../workspace/layout/layout-tree';
import { retainLateDrafts } from './late-draft-recovery';
import { detachProjectContent } from './project-content';

export async function transferProject(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  projects: DesktopWindowProjectsBridge,
  projectId: string,
  sessionProjects: ReadonlyMap<string, string>,
  untitledHome: string,
  sourceRoute: string,
  fence: (active: boolean) => void,
): Promise<void> {
  await transferContent(
    owner,
    { ...bridge, preparePane: (request) => projects.prepare(request) },
    projectId,
    (content) => detachProjectContent(content, projectId, sessionProjects, untitledHome),
    fence,
    sourceRoute,
  );
}

/** No live model moves between renderers. Transfer its captured working set, then remount. */
export async function transferPane(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  projectId: string,
  paneId: string,
  fence: (active: boolean) => void,
): Promise<void> {
  await transferContent(
    owner,
    bridge,
    projectId,
    (content) => detachPaneContent(content, projectId, paneId),
    fence,
  );
}

export function transferTab(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  projectId: string,
  ref: TabRef,
  fence: (active: boolean) => void,
  paneId?: string,
  sourceRoute?: string,
): Promise<void> {
  return transferContent(
    owner,
    bridge,
    projectId,
    (content) => detachTabContent(content, projectId, ref, paneId),
    fence,
    sourceRoute,
  ).then(() => undefined);
}

/** Return through the same handoff, then retire only an empty sealed source. */
export async function transferDock(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  projectId: string,
  paneId: string,
  destinationId: string,
  fence: (active: boolean) => void,
  suspend: (active: boolean) => void,
  placement?: DesktopPaneDock['placement'],
  destinationProjectId?: string,
): Promise<void> {
  if (!bridge.prepareDock || !bridge.retire) throw new Error('Pane docking is unavailable');
  const reference = await transferContent(
    owner,
    {
      ...bridge,
      preparePane: (request) =>
        bridge.prepareDock!({ ...request, destinationId, placement, destinationProjectId }),
    },
    projectId,
    (content) => detachPaneContent(content, projectId, paneId),
    fence,
  );
  await retireTransferredSource(owner, bridge, reference, projectId, fence, suspend);
}

/** An individual tab uses the same transaction but merges into a chosen existing pane. */
export async function transferTabIntoWindow(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  projectId: string,
  ref: TabRef,
  destination: Pick<DesktopTabDock, 'destinationId' | 'destinationProjectId' | 'placement'>,
  fence: (active: boolean) => void,
  suspend: (active: boolean) => void,
  retireSource: boolean,
  paneId?: string,
  sourceRoute?: string,
): Promise<void> {
  if (!bridge.prepareTabDock) throw new Error('Tab window transfers are unavailable');
  const reference = await transferContent(
    owner,
    { ...bridge, preparePane: (request) => bridge.prepareTabDock!({ ...request, ...destination }) },
    projectId,
    (content) => detachTabContent(content, projectId, ref, paneId),
    fence,
    sourceRoute,
  );
  if (retireSource)
    await retireTransferredSource(owner, bridge, reference, projectId, fence, suspend);
}

async function retireTransferredSource(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  reference: DesktopTransferReference,
  projectId: string,
  fence: (active: boolean) => void,
  suspend: (active: boolean) => void,
): Promise<void> {
  if (!bridge.retire) return;
  fence(true);
  let recovery: DesktopWorkspaceVersion | undefined;
  try {
    const captured = await owner.freeze();
    recovery = captured;
    owner.beginStaging();
    suspend(true);
    await Promise.resolve();
    // Release the old models before the final capture. Anything that completed
    // during their cleanup remains recoverable instead of closing with the window.
    owner.adopt(captured, captured, projectId);
    const sealed = await owner.freeze();
    recovery = sealed;
    const snapshot = sealed.content.snapshot;
    const trees =
      snapshot.layout_mode === 'project'
        ? Object.values(snapshot.project_layouts).map((slice) => slice.layout_tree)
        : [snapshot.layout_tree];
    if (sealed.content.buffers.length || trees.some((tree) => tree && flattenTabs(tree).length)) {
      owner.adopt(sealed);
      if (sealed.content.buffers.length) {
        owner.update(retainLateDrafts(snapshot, sealed.content.buffers, projectId));
        await owner.flush();
      }
      return;
    }
    await bridge.retire({ ...reference, revision: sealed.revision });
  } catch (error) {
    if (recovery && owner.locked()) owner.adopt(recovery, recovery, projectId);
    else owner.resume();
    throw error;
  } finally {
    if (!owner.locked()) {
      suspend(false);
      fence(false);
    }
  }
}

async function transferContent(
  owner: DesktopWorkingSet,
  bridge: DesktopWindowTransfersBridge,
  projectId: string,
  project: (content: DesktopWorkspaceContent) => {
    source: DesktopWorkspaceContent;
    destination: DesktopWorkspaceContent;
  },
  fence: (active: boolean) => void,
  sourceRoute?: string,
): Promise<DesktopTransferReference> {
  if (!owner.loaded() || owner.locked()) throw new Error('The workspace is not ready to detach');
  const reference = { id: crypto.randomUUID(), profileId: owner.profileId };
  let captured: DesktopWorkspaceVersion | undefined;
  const adopt = async (version: DesktopWorkspaceVersion) => {
    if (owner.adopt(version, captured, projectId)) await owner.flush();
  };
  fence(true);
  try {
    captured = await owner.freeze();
    const content = project(captured.content);
    await bridge.preparePane({
      ...reference,
      projectId,
      revision: captured.revision,
      ...content,
      ...(sourceRoute ? { sourceRoute } : {}),
    });
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
      return reference;
    }
    if (observed?.status === 'prepared') {
      const cancelled = await bridge.cancel(reference);
      if (cancelled.status === 'committed' && cancelled.version) {
        await adopt(cancelled.version);
        return reference;
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
  return reference;
}
