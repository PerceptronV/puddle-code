import { expect, it } from 'vitest';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { restoreHuddleView } from '../../../src/features/huddle/view/state';
import {
  huddleDropDestination,
  remapHuddleViewKey,
} from '../../../src/features/huddle/view/transfer';
import {
  dropTab,
  makeLeaf,
  makeSplit,
  tabRefKey,
} from '../../../src/features/workspace/layout/layout-tree';
import { detachTabContent } from '../../../src/features/windows/transfers/content/transfer-content';
import { dockTabContent } from '../../../src/features/windows/transfers/content/dock-content';

const ref = { type: 'huddle' as const, session: '00000000-0000-4000-8000-000000000001' };
const project = '0123456789';
const view = {
  format: 1,
  selectedNode: 'run',
  selectedEdge: 'edge',
  mode: 'list',
  camera: { x: 420, y: -40, zoom: 0.8 },
};
const tab = (pane: string, scope: string) =>
  JSON.stringify([`profile:${scope}`, pane, tabRefKey(ref)]);
const key = (pane: string, scope: string) =>
  'huddle:host:' + JSON.stringify([tab(pane, scope), 'huddle', [ref.session, '/tree']]);

it('ignores obsolete or invalid private payloads without discarding valid state', () => {
  expect(restoreHuddleView(view)).toEqual(view);
  for (const invalid of [
    null,
    { ...view, format: 2 },
    { ...view, camera: { ...view.camera, zoom: Infinity } },
    { ...view, selectedNode: '__proto__' },
    { ...view, extra: true },
  ])
    expect(restoreHuddleView(invalid)).toMatchObject({
      selectedNode: null,
      camera: null,
      mode: 'graph',
    });
});
it('carries huddle view identity through detach and docking without copying another pane selection', () => {
  const pane = makeLeaf([ref]);
  const source = {
    snapshot: uiStateSnapshotSchema.parse({
      layout_mode: 'project',
      project_layouts: { [project]: { layout_tree: pane } },
    }),
    buffers: [],
    views: {
      [key(pane.id, `project:${project}`)]: view,
      [key('other', `project:${project}`)]: { ...view, selectedNode: 'other' },
    },
  };
  const detached = detachTabContent(source, project, ref, pane.id);
  expect(detached.destination.views[key(pane.id, 'profile')]).toEqual(view);
  const target = makeLeaf([]);
  const docked = dockTabContent(
    { snapshot: uiStateSnapshotSchema.parse({ layout_tree: target }), buffers: [], views: {} },
    detached.destination,
    project,
    { paneId: target.id, edge: 'center' },
  );
  expect(docked.views[key(target.id, 'profile')]).toEqual(view);
  expect(Object.values(docked.views)).not.toContainEqual({ ...view, selectedNode: 'other' });
});
it('moves/copies same-window views but keeps an already-open duplicate independent', () => {
  const source = makeLeaf([ref]),
    target = makeLeaf([]);
  const before = makeSplit('row', [source, target]);
  for (const edge of ['center', 'right'] as const)
    for (const copy of [true, false]) {
      const spec = { ref, fromLeafId: source.id, toLeafId: target.id, edge, copy };
      const after = dropTab(before, spec);
      expect(huddleDropDestination(before, after, spec)).toBeDefined();
    }
  const duplicate = makeLeaf([ref]);
  const two = makeSplit('row', [source, duplicate]);
  const spec = { ref, fromLeafId: source.id, toLeafId: duplicate.id, edge: 'center' as const };
  expect(huddleDropDestination(two, dropTab(two, spec), spec)).toBeUndefined();
  const original = key(source.id, 'profile').slice('huddle:'.length);
  expect(
    remapHuddleViewKey(original, 'host:', tab(source.id, 'profile'), tab(target.id, 'profile')),
  ).toBe(key(target.id, 'profile').slice('huddle:'.length));
  expect(
    remapHuddleViewKey(
      original,
      'other-host:',
      tab(source.id, 'profile'),
      tab(target.id, 'profile'),
    ),
  ).toBeUndefined();
  expect(
    remapHuddleViewKey(
      original,
      'host:',
      tab(source.id, `project:${project}`),
      tab(target.id, 'profile'),
    ),
  ).toBeUndefined();
});
