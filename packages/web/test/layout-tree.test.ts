import { describe, expect, it } from 'vitest';
import type { LayoutNode, LayoutSplit, TabRef, UiStateSnapshot } from '@puddle/shared';
import { uiStateSnapshotSchema } from '@puddle/shared';
import {
  allLeaves,
  buildInitialTree,
  closeTab,
  dropTab,
  findLeaf,
  flattenTabs,
  focusTab,
  leafContainingKey,
  makeLeaf,
  moveTab,
  normalise,
  openPreview,
  promoteTab,
  resizeSplit,
  sameRef,
  splitLeaf,
  tabRefKey,
  addTabToLeaf,
} from '../src/features/workspace/layout-tree';

const ed = (path: string, session = 's1'): TabRef => ({ type: 'editor', tab: { session, path } });
const term = (session: string): TabRef => ({ type: 'terminal', session });
const asSplit = (n: LayoutNode): LayoutSplit => {
  if (n.kind !== 'split') throw new Error('expected a split');
  return n;
};
const leafWith = (tree: LayoutNode, ref: TabRef) => leafContainingKey(tree, tabRefKey(ref))!;

describe('tab identity', () => {
  it('keys editors by tab identity and terminals by session', () => {
    expect(tabRefKey(term('t1'))).toBe('term:t1');
    expect(tabRefKey(ed('a.ts'))).toBe('editor:file:s1::a.ts');
    expect(sameRef(ed('a.ts'), ed('a.ts'))).toBe(true);
    expect(sameRef(ed('a.ts'), ed('b.ts'))).toBe(false);
    expect(sameRef(term('t1'), term('t2'))).toBe(false);
  });
});

describe('makeLeaf', () => {
  it('activates the first tab by default, respects a provided key, nulls when empty', () => {
    expect(makeLeaf([ed('a.ts'), ed('b.ts')]).activeKey).toBe(tabRefKey(ed('a.ts')));
    expect(makeLeaf([ed('a.ts'), ed('b.ts')], tabRefKey(ed('b.ts'))).activeKey).toBe(
      tabRefKey(ed('b.ts')),
    );
    expect(makeLeaf([]).activeKey).toBeNull();
    // an activeKey not present falls back to the first tab
    expect(makeLeaf([ed('a.ts')], 'nope').activeKey).toBe(tabRefKey(ed('a.ts')));
  });
});

describe('splitLeaf', () => {
  it('right/left produce a row with the new leaf after/before', () => {
    const a = makeLeaf([ed('a.ts')]);
    const right = asSplit(splitLeaf(a, a.id, 'right', term('t1')));
    expect(right.direction).toBe('row');
    expect(right.sizes).toEqual([50, 50]);
    expect(right.children[0]!.id).toBe(a.id); // original stays first
    expect((right.children[1] as never as { tabs: TabRef[] }).tabs).toEqual([term('t1')]);

    const left = asSplit(splitLeaf(a, a.id, 'left', term('t1')));
    expect(leafWith(left, term('t1')).id).toBe(asSplit(left).children[0]!.id); // new leaf first
  });

  it('top/bottom produce a column', () => {
    const a = makeLeaf([ed('a.ts')]);
    expect(asSplit(splitLeaf(a, a.id, 'top', ed('b.ts'))).direction).toBe('col');
    expect(asSplit(splitLeaf(a, a.id, 'bottom', ed('b.ts'))).direction).toBe('col');
  });
});

describe('flattenTabs', () => {
  it('lists every tab in DFS order', () => {
    const a = makeLeaf([ed('a.ts')]);
    const tree = splitLeaf(a, a.id, 'right', term('t1'));
    expect(flattenTabs(tree).map(tabRefKey)).toEqual(['editor:file:s1::a.ts', 'term:t1']);
  });
});

describe('dropTab', () => {
  it('moves a terminal between leaves (unique — leaves it nowhere else)', () => {
    const a = makeLeaf([ed('a.ts')]);
    let tree = splitLeaf(a, a.id, 'right', ed('b.ts')); // [leafA(a.ts), leafB(b.ts)]
    const leafA = leafWith(tree, ed('a.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    // seed a terminal into leafA, then move it to leafB
    tree = dropTab(tree, {
      ref: term('t1'),
      fromLeafId: leafA.id,
      toLeafId: leafA.id,
      edge: 'center',
    });
    const withTermA = leafWith(tree, term('t1'));
    tree = dropTab(tree, {
      ref: term('t1'),
      fromLeafId: withTermA.id,
      toLeafId: leafB.id,
      edge: 'center',
    });
    expect(flattenTabs(tree).filter((t) => sameRef(t, term('t1')))).toHaveLength(1); // exactly once
    expect(leafContainingKey(tree, 'term:t1')!.tabs.map(tabRefKey)).toContain('term:t1');
  });

  it('moves an editor dropped into a different leaf (a drag leaves nothing behind)', () => {
    const a = makeLeaf([ed('a.ts'), ed('x.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafA = leafWith(tree, ed('a.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafA.id,
      toLeafId: leafB.id,
      edge: 'center',
    });
    // a.ts appears exactly once, in leaf B; the source keeps only x.ts.
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(1);
    expect(leafWith(next, ed('a.ts')).id).toBe(leafB.id);
    expect(findLeaf(next, leafA.id)!.tabs.map(tabRefKey)).toEqual(['editor:file:s1::x.ts']);
  });

  it('reorders within the same leaf (move, not duplicate)', () => {
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts'), ed('c.ts')]);
    const next = moveTab(leaf, ed('c.ts'), leaf.id, leaf.id, 0);
    expect(allLeaves(next)[0]!.tabs.map((t) => tabRefKey(t))).toEqual([
      'editor:file:s1::c.ts',
      'editor:file:s1::a.ts',
      'editor:file:s1::b.ts',
    ]);
  });

  it('compensates a rightward same-leaf reorder for the dragged tab still being visible', () => {
    // The strip shows [a, b, c]; the user drops `a` before `c` (visible index 2).
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts'), ed('c.ts')]);
    const next = moveTab(leaf, ed('a.ts'), leaf.id, leaf.id, 2);
    expect(allLeaves(next)[0]!.tabs.map(tabRefKey)).toEqual([
      'editor:file:s1::b.ts',
      'editor:file:s1::a.ts',
      'editor:file:s1::c.ts',
    ]);
    // …and dropping past the last tab (visible index 3) lands at the end.
    const toEnd = moveTab(leaf, ed('a.ts'), leaf.id, leaf.id, 3);
    expect(allLeaves(toEnd)[0]!.tabs.map(tabRefKey)).toEqual([
      'editor:file:s1::b.ts',
      'editor:file:s1::c.ts',
      'editor:file:s1::a.ts',
    ]);
  });

  it('inserts at the given index on a cross-leaf center drop', () => {
    const a = makeLeaf([ed('a.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafWith(tree, ed('a.ts')).id,
      toLeafId: leafB.id,
      edge: 'center',
      index: 0,
    });
    // Source emptied and collapsed; B's strip is [a, b].
    expect(allLeaves(next)).toHaveLength(1);
    expect(allLeaves(next)[0]!.tabs.map(tabRefKey)).toEqual([
      'editor:file:s1::a.ts',
      'editor:file:s1::b.ts',
    ]);
  });

  it('edge-splits the target leaf, moving the tab out of its source', () => {
    const a = makeLeaf([ed('a.ts'), ed('x.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafWith(tree, ed('a.ts')).id,
      toLeafId: leafB.id,
      edge: 'bottom',
    });
    // a.ts lives only in the new leaf below B.
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(1);
    expect(leafWith(next, ed('a.ts')).id).not.toBe(leafB.id);
  });

  it('self-heals a legacy duplicated tab: a drag removes every copy tree-wide', () => {
    // Old builds duplicated editors across panes; such trees still exist in
    // storage. Dragging any copy must leave exactly ONE copy, at the drop site.
    const a = makeLeaf([ed('a.ts'), ed('x.ts')]);
    let tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    // Hand-plant the duplicate (as a legacy snapshot would): a.ts also in leafB.
    tree = {
      ...tree,
      children: (tree as LayoutSplit).children.map((c) =>
        c.id === leafB.id && c.kind === 'leaf' ? { ...c, tabs: [...c.tabs, ed('a.ts')] } : c,
      ),
    } as LayoutNode;
    expect(flattenTabs(tree).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(2);
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafWith(tree, ed('x.ts')).id,
      toLeafId: leafB.id,
      edge: 'center',
      index: 0,
    });
    expect(flattenTabs(next).filter((t) => sameRef(t, ed('a.ts')))).toHaveLength(1);
    expect(findLeaf(next, leafB.id)!.tabs.map(tabRefKey)[0]).toBe('editor:file:s1::a.ts');
  });

  it('pins a preview tab on any drop (drag = deliberate placement)', () => {
    // Preview a.ts in its own leaf, then split another leaf off it and drag the
    // preview across — the moved tab must arrive permanent.
    const seed = makeLeaf([ed('x.ts')]);
    const withPreview = openPreview(seed, seed.id, ed('a.ts'));
    const src = leafWith(withPreview, ed('a.ts'));
    expect(src.previewKey).toBe(tabRefKey(ed('a.ts')));
    const tree = splitLeaf(withPreview, src.id, 'right', ed('b.ts'));
    const to = leafWith(tree, ed('b.ts'));
    const next = dropTab(tree, {
      ref: ed('a.ts'),
      fromLeafId: leafWith(tree, ed('a.ts')).id,
      toLeafId: to.id,
      edge: 'center',
    });
    for (const leaf of allLeaves(next)) {
      expect(leaf.previewKey).not.toBe(tabRefKey(ed('a.ts')));
    }
    // A same-leaf reorder pins too.
    const reordered = moveTab(withPreview, ed('a.ts'), src.id, src.id, 0);
    expect(leafWith(reordered, ed('a.ts')).previewKey).toBeNull();
  });
});

describe('closeTab', () => {
  it('activates the right neighbour, else left', () => {
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts'), ed('c.ts')], tabRefKey(ed('b.ts')));
    const afterB = closeTab(leaf, leaf.id, tabRefKey(ed('b.ts')));
    expect(allLeaves(afterB)[0]!.activeKey).toBe(tabRefKey(ed('c.ts'))); // right neighbour
    const afterC = closeTab(afterB, allLeaves(afterB)[0]!.id, tabRefKey(ed('c.ts')));
    expect(allLeaves(afterC)[0]!.activeKey).toBe(tabRefKey(ed('a.ts'))); // left, no right neighbour
  });

  it('drops an emptied leaf and collapses the split', () => {
    const a = makeLeaf([ed('a.ts')]);
    const tree = splitLeaf(a, a.id, 'right', ed('b.ts'));
    const leafB = leafWith(tree, ed('b.ts'));
    const collapsed = closeTab(tree, leafB.id, tabRefKey(ed('b.ts')));
    expect(collapsed.kind).toBe('leaf'); // split collapsed to the surviving leaf
    expect(flattenTabs(collapsed).map(tabRefKey)).toEqual(['editor:file:s1::a.ts']);
  });

  it('preserves a sole empty root leaf (the empty-workspace state)', () => {
    const leaf = makeLeaf([ed('a.ts')]);
    const empty = closeTab(leaf, leaf.id, tabRefKey(ed('a.ts')));
    expect(empty.kind).toBe('leaf');
    expect(flattenTabs(empty)).toEqual([]);
  });
});

describe('focusTab & resizeSplit', () => {
  it('focusTab sets the active key only when the tab is present', () => {
    const leaf = makeLeaf([ed('a.ts'), ed('b.ts')]);
    expect(allLeaves(focusTab(leaf, leaf.id, tabRefKey(ed('b.ts'))))[0]!.activeKey).toBe(
      tabRefKey(ed('b.ts')),
    );
  });

  it('resizeSplit writes sizes for the matching split id', () => {
    const a = makeLeaf([ed('a.ts')]);
    const split = asSplit(splitLeaf(a, a.id, 'right', ed('b.ts')));
    const resized = asSplit(resizeSplit(split, split.id, [30, 70]));
    expect(resized.sizes).toEqual([30, 70]);
  });
});

describe('normalise', () => {
  it('flattens a same-direction child split, distributing its size', () => {
    // Hand-build a row containing a row (via two right-splits) and check flattening.
    const a = makeLeaf([ed('a.ts')]);
    let tree = splitLeaf(a, a.id, 'right', ed('b.ts')); // row[A,B] sizes[50,50]
    const leafB = leafWith(tree, ed('b.ts'));
    tree = splitLeaf(tree, leafB.id, 'right', ed('c.ts')); // B becomes row[B,C]; flattened → row[A,B,C]
    const split = asSplit(tree);
    expect(split.direction).toBe('row');
    expect(split.children).toHaveLength(3); // flattened, not nested
    expect(split.children.every((c) => c.kind === 'leaf')).toBe(true);
    // A kept 50; B/C split the other 50 → [50, 25, 25]
    expect(split.sizes).toEqual([50, 25, 25]);
  });

  it('collapses a single-child split and fixes a stale activeKey', () => {
    const leaf = { kind: 'leaf', id: 'x', tabs: [ed('a.ts')], activeKey: 'stale' } as LayoutNode;
    expect(allLeaves(normalise(leaf))[0]!.activeKey).toBe(tabRefKey(ed('a.ts')));
  });
});

describe('buildInitialTree (legacy migration)', () => {
  const base = (over: Partial<UiStateSnapshot>): UiStateSnapshot =>
    uiStateSnapshotSchema.parse({ ...over });

  it('stacks editor tabs above terminals in a column with layout sizes', () => {
    const s = crypto.randomUUID();
    const snap = base({
      editor_tabs: [{ session: s, path: 'a.ts' }],
      session_tabs: [s],
      layout: { editor: 35, session: 65 },
    });
    const tree = asSplit(buildInitialTree(snap));
    expect(tree.direction).toBe('col');
    expect(tree.sizes).toEqual([35, 65]);
    expect(flattenTabs(tree).map(tabRefKey)).toEqual([`editor:file:${s}::a.ts`, `term:${s}`]);
  });

  it('collapses to a single leaf when only one side has tabs', () => {
    const s = crypto.randomUUID();
    expect(buildInitialTree(base({ session_tabs: [s] })).kind).toBe('leaf');
    expect(buildInitialTree(base({ editor_tabs: [{ session: s, path: 'a.ts' }] })).kind).toBe(
      'leaf',
    );
  });

  it('returns an empty leaf for an empty snapshot', () => {
    const tree = buildInitialTree(base({}));
    expect(tree.kind).toBe('leaf');
    expect(flattenTabs(tree)).toEqual([]);
  });
});

describe('schema round-trip', () => {
  it('a built tree survives parse through uiStateSnapshotSchema unchanged', () => {
    const s = crypto.randomUUID();
    const tree = buildInitialTree(
      uiStateSnapshotSchema.parse({
        editor_tabs: [{ session: s, path: 'a.ts' }],
        session_tabs: [s],
      }),
    );
    const parsed = uiStateSnapshotSchema.parse({ layout_tree: tree });
    expect(parsed.layout_tree).toEqual(tree);
  });

  it('defaults layout_tree to null on a legacy snapshot', () => {
    expect(uiStateSnapshotSchema.parse({}).layout_tree).toBeNull();
  });
});

describe('findLeaf', () => {
  it('locates a leaf by id and returns null for an unknown id', () => {
    const leaf = makeLeaf([ed('a.ts')]);
    expect(findLeaf(leaf, leaf.id)?.id).toBe(leaf.id);
    expect(findLeaf(leaf, 'nope')).toBeNull();
  });
});

describe('preview tabs (VSCode-style ephemeral tabs)', () => {
  const keyOf = (ref: TabRef) => tabRefKey(ref);

  it('a single-click open becomes the preview tab (previewKey === activeKey)', () => {
    const leaf = makeLeaf([]);
    const next = leafWith(openPreview(leaf, leaf.id, ed('a.ts')), ed('a.ts'));
    expect(next.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts'))]);
    expect(next.activeKey).toBe(keyOf(ed('a.ts')));
    expect(next.previewKey).toBe(keyOf(ed('a.ts')));
  });

  it('a second single-click replaces the preview tab in place (one slot)', () => {
    const leaf = makeLeaf([]);
    const t1 = openPreview(leaf, leaf.id, ed('a.ts'));
    const t2 = openPreview(t1, leaf.id, ed('b.ts'));
    const l = leafWith(t2, ed('b.ts'));
    // a.ts is gone; b.ts took its slot and is the new preview
    expect(l.tabs.map(keyOf)).toEqual([keyOf(ed('b.ts'))]);
    expect(l.previewKey).toBe(keyOf(ed('b.ts')));
  });

  it('does not replace a permanent tab, and re-opening a permanent tab keeps it', () => {
    const leaf = makeLeaf([]);
    const withPerm = addTabToLeaf(leaf, leaf.id, ed('a.ts')); // permanent
    const withPreview = openPreview(withPerm, leaf.id, ed('b.ts')); // preview alongside
    const l = leafWith(withPreview, ed('b.ts'));
    expect(l.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts')), keyOf(ed('b.ts'))]);
    expect(l.previewKey).toBe(keyOf(ed('b.ts')));
    // single-clicking the permanent tab just focuses it — no preview change
    const focused = leafWith(openPreview(withPreview, l.id, ed('a.ts')), ed('a.ts'));
    expect(focused.previewKey).toBe(keyOf(ed('b.ts')));
    expect(focused.activeKey).toBe(keyOf(ed('a.ts')));
  });

  it('never discards a preview terminal — it pins it and opens the new tab alongside', () => {
    const leaf = makeLeaf([]);
    const withTerm = openPreview(leaf, leaf.id, term('t1')); // preview terminal (live PTY)
    const withFile = openPreview(withTerm, leaf.id, ed('a.ts')); // open a file preview
    const l = leafWith(withFile, term('t1'));
    // the terminal survives (now permanent), the file is the new preview
    expect(l.tabs.map(keyOf)).toEqual([keyOf(term('t1')), keyOf(ed('a.ts'))]);
    expect(l.previewKey).toBe(keyOf(ed('a.ts')));
  });

  it('double-click (promoteTab) pins the preview tab', () => {
    const leaf = makeLeaf([]);
    const previewed = openPreview(leaf, leaf.id, ed('a.ts'));
    const pinned = leafWith(promoteTab(previewed, keyOf(ed('a.ts'))), ed('a.ts'));
    expect(pinned.previewKey).toBeNull();
    expect(pinned.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts'))]);
  });

  it('opening a preview tab permanently (addTabToLeaf) promotes it', () => {
    const leaf = makeLeaf([]);
    const previewed = openPreview(leaf, leaf.id, ed('a.ts'));
    const promoted = leafWith(addTabToLeaf(previewed, leaf.id, ed('a.ts')), ed('a.ts'));
    expect(promoted.previewKey).toBeNull();
  });

  it('closing the preview tab clears previewKey (normalise)', () => {
    const leaf = makeLeaf([]);
    const withPerm = addTabToLeaf(leaf, leaf.id, ed('a.ts'));
    const withPreview = openPreview(withPerm, leaf.id, ed('b.ts'));
    const l = leafWith(withPreview, ed('b.ts'));
    const closed = leafWith(closeTab(withPreview, l.id, keyOf(ed('b.ts'))), ed('a.ts'));
    expect(closed.previewKey).toBeNull();
    expect(closed.tabs.map(keyOf)).toEqual([keyOf(ed('a.ts'))]);
  });
});
