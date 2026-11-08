import type { LayoutNode } from '@puddle/shared';
import { allLeaves, findLeaf, tabRefKey, type DropSpec } from '../../workspace/layout/layout-tree';
import { huddleViews } from './state';
import { currentProfileId } from '../../profile/profile-store';
import { browserScope } from '../../../lib/transport/browser-transport';

export function huddleDropDestination(before: LayoutNode, after: LayoutNode, spec: DropSpec) {
  if (spec.ref.type !== 'huddle' || !spec.fromLeafId || before === after) return;
  const key = tabRefKey(spec.ref);
  if (!findLeaf(before, spec.fromLeafId)?.tabs.some((tab) => tabRefKey(tab) === key)) return;
  const contains = (id: string) => findLeaf(after, id)?.tabs.some((tab) => tabRefKey(tab) === key);
  const previousIds = new Set(allLeaves(before).map((leaf) => leaf.id));
  const destination =
    spec.edge === 'center' && contains(spec.toLeafId)
      ? spec.toLeafId
      : allLeaves(after).find((leaf) => !previousIds.has(leaf.id) && contains(leaf.id))?.id;
  if (!destination || destination === spec.fromLeafId) return;
  // Focusing an existing duplicate keeps that view's own navigation.
  if (findLeaf(before, destination)?.tabs.some((tab) => tabRefKey(tab) === key)) return;
  return destination;
}

export function remapHuddleViewKey(
  key: string,
  host: string,
  from: string,
  to: string,
): string | undefined {
  if (!key.startsWith(host)) return;
  try {
    const value: unknown = JSON.parse(key.slice(host.length));
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== from || value[1] !== 'huddle')
      return;
    return host + JSON.stringify([to, ...value.slice(1)]);
  } catch {
    return;
  }
}

export function transferHuddleDropView(
  before: LayoutNode,
  after: LayoutNode,
  spec: DropSpec,
  scope: string,
) {
  const destination = huddleDropDestination(before, after, spec);
  if (!destination) return;
  const channel = `${currentProfileId() ?? ''}:${scope}`;
  const key = tabRefKey(spec.ref);
  const from = JSON.stringify([channel, spec.fromLeafId, key]);
  const to = JSON.stringify([channel, destination, key]);
  const host = browserScope('');
  huddleViews.copyKeys((value) => remapHuddleViewKey(value, host, from, to));
}
