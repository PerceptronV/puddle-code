import { expect, it } from 'vitest';
import { uiStateSnapshotSchema, type DesktopWorkspaceContent, type TabRef } from '@puddle/shared';
import {
  makeLeaf,
  flattenTabs,
  tabRefKey,
} from '../../../../src/features/workspace/layout/layout-tree';
import {
  detachPaneContent,
  detachTabContent,
} from '../../../../src/features/windows/transfers/content/transfer-content';

const session = '00000000-0000-4000-8000-000000000001';
const editor = (path: string): TabRef => ({ type: 'editor', tab: { session, path } });
const draft = (path: string) => ({ session, path, content: `unsaved ${path}`, baseMtimeMs: 1 });

it('moves exactly the selected pane with order, active tab, preview slot and dirty text intact', () => {
  const first = makeLeaf([editor('stay.ts')]);
  const terminal: TabRef = { type: 'terminal', session };
  const selected = makeLeaf([terminal, editor('move.ts')], tabRefKey(editor('move.ts')));
  selected.previewKey = selected.activeKey;
  const input: DesktopWorkspaceContent = {
    snapshot: uiStateSnapshotSchema.parse({
      active_session: session,
      layout_tree: {
        kind: 'split',
        id: 'split',
        direction: 'row',
        children: [first, selected],
        sizes: [40, 60],
      },
    }),
    buffers: [draft('stay.ts'), draft('move.ts'), draft('orphan.ts')],
    views: { 'code-view': { position: { lineNumber: 12, column: 4 } } },
  };
  const result = detachPaneContent(input, '1234567890', selected.id);
  expect(result.destination.snapshot.layout_tree).toEqual(selected);
  expect(result.source.snapshot.layout_tree).toEqual(first);
  expect(result.destination.snapshot.active_session).toBeNull();
  expect(result.source.snapshot.active_session).toBeNull();
  expect(result.destination.buffers).toEqual([draft('move.ts')]);
  expect(result.source.buffers).toEqual([draft('stay.ts'), draft('orphan.ts')]);
  expect(result.destination.views).toEqual(input.views);
  expect(flattenTabs(input.snapshot.layout_tree!)).toHaveLength(3);
});

it('retains dirty duplicate views and other project slices without changing layout mode', () => {
  const pane = makeLeaf([editor('shared.ts')]);
  const other = makeLeaf([editor('shared.ts')]);
  const snapshot = uiStateSnapshotSchema.parse({
    layout_mode: 'project',
    project_layouts: {
      '1234567890': { layout_tree: pane },
      abcdef1234: { layout_tree: other },
    },
  });
  const result = detachPaneContent(
    { snapshot, buffers: [draft('shared.ts')], views: {} },
    '1234567890',
    pane.id,
  );
  expect(result.source.snapshot.layout_mode).toBe('project');
  expect(result.source.snapshot.project_layouts['abcdef1234']).toEqual(
    snapshot.project_layouts['abcdef1234'],
  );
  expect(flattenTabs(result.source.snapshot.project_layouts['1234567890']!.layout_tree!)).toEqual(
    [],
  );
  expect(result.source.buffers).toEqual(result.destination.buffers);
  expect(result.destination.snapshot.project_layouts).toEqual({});
  expect(result.destination.snapshot.layout_mode).toBe('profile');
});

it('rejects a stale pane selection without altering the captured workspace', () => {
  const input: DesktopWorkspaceContent = {
    snapshot: uiStateSnapshotSchema.parse({ layout_tree: makeLeaf([editor('stay.ts')]) }),
    buffers: [draft('stay.ts')],
    views: {},
  };
  const original = structuredClone(input);
  expect(() => detachPaneContent(input, '1234567890', 'removed-pane')).toThrow('pane has changed');
  expect(input).toEqual(original);
});

it('moves the selected file view while preserving other tabs and a dirty duplicate view', () => {
  const selected = makeLeaf([editor('stay.ts'), editor('move.ts')]);
  const duplicate = makeLeaf([editor('move.ts')]);
  const snapshot = uiStateSnapshotSchema.parse({
    layout_tree: {
      kind: 'split',
      id: 'row',
      direction: 'row',
      children: [selected, duplicate],
      sizes: [50, 50],
    },
  });
  const result = detachTabContent(
    { snapshot, buffers: [draft('move.ts')], views: {} },
    '1234567890',
    editor('move.ts'),
    selected.id,
  );
  expect(flattenTabs(result.source.snapshot.layout_tree!)).toEqual([
    editor('stay.ts'),
    editor('move.ts'),
  ]);
  expect(flattenTabs(result.destination.snapshot.layout_tree!)).toEqual([editor('move.ts')]);
  expect(result.destination.snapshot.layout_tree?.id).toBe(selected.id);
  expect(result.source.buffers).toEqual(result.destination.buffers);
});

it('opens an unopened file without moving unrelated source tabs or drafts', () => {
  const source: DesktopWorkspaceContent = {
    snapshot: uiStateSnapshotSchema.parse({ layout_tree: makeLeaf([editor('stay.ts')]) }),
    buffers: [draft('stay.ts')],
    views: {},
  };
  const result = detachTabContent(source, '1234567890', editor('new.ts'));
  expect(result.source).toEqual(source);
  expect(flattenTabs(result.destination.snapshot.layout_tree!)).toEqual([editor('new.ts')]);
  expect(result.destination.buffers).toEqual([]);
});

it('moves a parked session from its own project slice without changing the visible project', () => {
  const terminal: TabRef = { type: 'terminal', session };
  const snapshot = uiStateSnapshotSchema.parse({
    layout_mode: 'project',
    project_layouts: {
      '1234567890': { layout_tree: makeLeaf([editor('stay.ts')]) },
      abcdef1234: { layout_tree: makeLeaf([terminal]), active_session: session },
    },
  });
  const result = detachTabContent({ snapshot, buffers: [], views: {} }, 'abcdef1234', terminal);
  expect(result.source.snapshot.project_layouts['1234567890']).toEqual(
    snapshot.project_layouts['1234567890'],
  );
  expect(result.source.snapshot.project_layouts['abcdef1234']?.active_session).toBeNull();
  expect(result.destination.snapshot.active_session).toBe(session);
  expect(flattenTabs(result.destination.snapshot.layout_tree!)).toEqual([terminal]);
});
