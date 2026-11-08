import type { DesktopBufferSnapshot, TabRef } from '@puddle/shared';
import type { UiStateHandle } from '../../workspace/use-ui-state';
import { closeTab, tabRefKey } from '../../workspace/layout/layout-tree';
import { updateWorkspaceTrees } from '../../workspace/layout/update-workspace-trees';
import { windowBufferKey } from '../state/content-state';

export function recoveryCloseKey(buffer: DesktopBufferSnapshot): string {
  return JSON.stringify(['orphaned-draft', windowBufferKey(buffer)]);
}

/** Recovery can expose tabs in historical trees as well as the current project. */
export function closeRecoveredFile(base: UiStateHandle, paneId: string, ref: TabRef): void {
  updateWorkspaceTrees(base, (tree) => closeTab(tree, paneId, tabRefKey(ref)));
}
