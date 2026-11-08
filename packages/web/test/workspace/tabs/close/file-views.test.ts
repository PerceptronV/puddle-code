import { expect, it } from 'vitest';
import { uiStateSnapshotSchema, type EditorTabRef, type LayoutLeaf } from '@puddle/shared';
import { fileViewCount } from '../../../../src/features/workspace/tabs/close/file-views';

const file = { session: '00000000-0000-4000-8000-000000000001', path: 'README.md' };
const leaf = (id: string, tabs: EditorTabRef[]): LayoutLeaf => ({
  kind: 'leaf',
  id,
  activeKey: null,
  tabs: tabs.map((tab) => ({ type: 'editor', tab })),
});

it('counts inactive source, preview and diff views but excludes immutable and untitled copies', () => {
  const snapshot = uiStateSnapshotSchema.parse({
    layout_tree: {
      kind: 'split',
      id: 'split',
      direction: 'row',
      sizes: [50, 50],
      children: [
        leaf('source', [file]),
        leaf('copies', [
          { ...file, view: 'locked' },
          { ...file, kind: 'diff' },
          { ...file, kind: 'commit', sha: 'abc' },
          { ...file, kind: 'untitled' },
          { ...file, root: '/other' },
          { ...file, session: '00000000-0000-4000-8000-000000000002' },
        ]),
      ],
    },
  });
  expect(fileViewCount(snapshot, file)).toBe(3);
  expect(fileViewCount(snapshot, { ...file, root: '/other' })).toBe(1);
});

it('counts parked project views once and ignores obsolete trees from the other layout mode', () => {
  const snapshot = uiStateSnapshotSchema.parse({
    layout_mode: 'project',
    layout_tree: leaf('old-profile-tree', [file]),
    project_layouts: {
      '0000000001': { layout_tree: leaf('project-a', [file]) },
      '0000000002': { layout_tree: leaf('project-b', [file]) },
    },
  });
  expect(fileViewCount(snapshot, file)).toBe(2);
  expect(fileViewCount({ ...snapshot, layout_mode: 'profile' }, file)).toBe(1);
  expect(fileViewCount({ ...snapshot, layout_mode: 'profile', layout_tree: null }, file)).toBe(0);
});
