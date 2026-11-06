import { describe, expect, it } from 'vitest';
import { UNTITLED_SESSION, uiStateSnapshotSchema, type TabRef } from '@puddle/shared';
import { makeLeaf, flattenTabs, tabRefKey } from '../../src/features/workspace/layout/layout-tree';
import {
  replaceUntitled,
  discardUntitled,
} from '../../src/features/workspace/tabs/untitled-layout';
import { updateWorkspaceTrees } from '../../src/features/workspace/layout/update-workspace-trees';

const draft: TabRef = {
  type: 'editor',
  tab: { kind: 'untitled', session: UNTITLED_SESSION, path: 'untitled-1.md' },
};
const saved = {
  kind: 'file' as const,
  session: '00000000-0000-4000-8000-000000000001',
  path: 'saved.md',
};
const other: TabRef = { type: 'editor', tab: { ...saved, path: 'other.md' } };

describe('draft layout identity changes', () => {
  it('replaces all copies without moving focus, split geometry or other tabs', () => {
    const left = makeLeaf([draft, other]);
    left.previewKey = tabRefKey(draft);
    const right = makeLeaf([draft, other], tabRefKey(other));
    const tree = {
      kind: 'split' as const,
      id: 'split',
      direction: 'row' as const,
      children: [left, right],
      sizes: [30, 70],
    };
    const next = replaceUntitled(tree, 'untitled-1.md', saved);
    expect(flattenTabs(next)).toEqual([
      { type: 'editor', tab: saved },
      other,
      { type: 'editor', tab: saved },
      other,
    ]);
    expect(next.kind === 'split' && next.sizes).toEqual([30, 70]);
    if (next.kind !== 'split') throw new Error('Lost split');
    expect(next.children[0]).toMatchObject({
      activeKey: tabRefKey({ type: 'editor', tab: saved }),
      previewKey: null,
    });
    expect(next.children[1]).toMatchObject({ activeKey: tabRefKey(other) });
  });

  it('discards copies across panes while retaining unrelated files', () => {
    const tree = {
      kind: 'split' as const,
      id: 'split',
      direction: 'row' as const,
      children: [makeLeaf([draft]), makeLeaf([draft, other])],
      sizes: [50, 50],
    };
    expect(flattenTabs(discardUntitled(tree, 'untitled-1.md'))).toEqual([other]);
  });

  it('reads latest persisted scopes and retains later additions and slice metadata', () => {
    let snapshot = uiStateSnapshotSchema.parse({
      project_layouts: { first: { layout_tree: makeLeaf([draft]), layout_ref: 12 } },
    });
    const base = {
      loaded: true,
      snapshot,
      current: () => snapshot,
      update: (patch: Partial<typeof snapshot>) => {
        snapshot = { ...snapshot, ...patch };
      },
    };
    // Another action committed after this render's handle was captured.
    snapshot = {
      ...snapshot,
      project_layouts: {
        ...snapshot.project_layouts,
        second: { layout_tree: makeLeaf([other]), layout_ref: null, active_session: null },
      },
    };
    const second = snapshot.project_layouts.second;
    updateWorkspaceTrees(base, (tree) => replaceUntitled(tree, 'untitled-1.md', saved));
    expect(snapshot.project_layouts.second).toBe(second);
    expect(snapshot.project_layouts.first?.layout_ref).toBe(12);
    expect(flattenTabs(snapshot.project_layouts.first!.layout_tree!)).toEqual([
      { type: 'editor', tab: saved },
    ]);
  });
});
