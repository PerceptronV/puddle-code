import type { UiStateSnapshot } from '@puddle/shared';
import { allLeaves, tabRefKey } from '../../workspace/layout/layout-tree';

/** The last session binding is not permission to replace a saved active editor on reload. */
export function hasInactiveSavedSession(snapshot: UiStateSnapshot, session: string): boolean {
  if (!snapshot.layout_tree || snapshot.active_session !== session) return false;
  const leaves = allLeaves(snapshot.layout_tree);
  return (
    leaves.some((leaf) =>
      leaf.tabs.some((tab) => tab.type !== 'editor' && tab.session === session),
    ) &&
    !leaves.some((leaf) =>
      leaf.tabs.some(
        (tab) =>
          tab.type !== 'editor' && tab.session === session && leaf.activeKey === tabRefKey(tab),
      ),
    )
  );
}

/** Native activation is a one-time intent, not a command to repeat after reload. */
export function consumeNativeSessionActivation(session: string, key: string): void {
  const state: unknown = window.history.state;
  if (
    !state ||
    typeof state !== 'object' ||
    !('key' in state) ||
    state.key !== key ||
    !('usr' in state) ||
    !state.usr ||
    typeof state.usr !== 'object' ||
    !('notificationSession' in state.usr) ||
    state.usr.notificationSession !== session
  )
    return;
  const usr = { ...state.usr };
  delete (usr as { notificationSession?: unknown }).notificationSession;
  window.history.replaceState({ ...state, usr }, '');
}
