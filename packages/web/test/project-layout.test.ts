import { describe, expect, it } from 'vitest';
import {
  UNTITLED_SESSION,
  uiStateSnapshotSchema,
  type TabRef,
  type UiStateSnapshot,
} from '@puddle/shared';
import { flattenTabs, joinTrees, makeLeaf, tabRefKey } from '../src/features/workspace/layout-tree';
import {
  scopedSnapshot,
  scopeUiState,
  splitToProjects,
  unionToProfile,
} from '../src/features/workspace/project-layout';
import type { UiStateHandle } from '../src/features/workspace/use-ui-state';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const PA = 'aaaaaaaaaa';
const PB = 'bbbbbbbbbb';

const term = (session: string): TabRef => ({ type: 'terminal', session });
const ed = (session: string, path: string): TabRef => ({ type: 'editor', tab: { session, path } });
const untitled = (): TabRef => ({
  type: 'editor',
  tab: { session: UNTITLED_SESSION, path: 'untitled-1.md', kind: 'untitled' },
});
const snap = (over: Record<string, unknown>): UiStateSnapshot => uiStateSnapshotSchema.parse(over);
const keys = (tree: Parameters<typeof flattenTabs>[0]) => flattenTabs(tree).map(tabRefKey);

const OWNER = new Map([
  [S1, PA],
  [S2, PB],
  [S3, PB],
]);

describe('splitToProjects', () => {
  it('gives each project the shared tree pruned to its own tabs', () => {
    const s = snap({
      layout_tree: makeLeaf([term(S1), ed(S2, 'a.ts'), term(S3)]),
      active_session: S2,
    });
    const patch = splitToProjects(s, [PA, PB], OWNER, null);
    expect(patch.layout_mode).toBe('project');
    const layouts = patch.project_layouts!;
    expect(keys(layouts[PA]!.layout_tree!)).toEqual([tabRefKey(term(S1))]);
    expect(keys(layouts[PB]!.layout_tree!)).toEqual([
      tabRefKey(ed(S2, 'a.ts')),
      tabRefKey(term(S3)),
    ]);
    // the bound session lands only in its own project's slice
    expect(layouts[PA]!.active_session).toBeNull();
    expect(layouts[PB]!.active_session).toBe(S2);
  });

  it('sends worktree-agnostic untitled drafts to the project that was open', () => {
    const s = snap({ layout_tree: makeLeaf([untitled(), term(S1)]) });
    const layouts = splitToProjects(s, [PA, PB], OWNER, PB).project_layouts!;
    expect(keys(layouts[PA]!.layout_tree!)).toEqual([tabRefKey(term(S1))]);
    expect(keys(layouts[PB]!.layout_tree!)).toEqual([tabRefKey(untitled())]);
    // …and to the first project when the flip happened with none open
    const fallback = splitToProjects(s, [PA, PB], OWNER, null).project_layouts!;
    expect(keys(fallback[PA]!.layout_tree!)).toContain(tabRefKey(untitled()));
  });

  it('rebuilds a legacy flat snapshot (null layout_tree) before splitting', () => {
    const s = snap({ session_tabs: [S1, S2], active_session: S1 });
    const layouts = splitToProjects(s, [PA, PB], OWNER, null).project_layouts!;
    expect(keys(layouts[PA]!.layout_tree!)).toEqual([tabRefKey(term(S1))]);
    expect(layouts[PA]!.active_session).toBe(S1);
    expect(keys(layouts[PB]!.layout_tree!)).toEqual([tabRefKey(term(S2))]);
  });
});

describe('unionToProfile', () => {
  it('unions slices in the given order, dedupes tabs, and clears the slices', () => {
    const s = snap({
      layout_mode: 'project',
      project_layouts: {
        [PA]: { layout_tree: makeLeaf([term(S1), ed(S2, 'a.ts')]), active_session: null },
        [PB]: { layout_tree: makeLeaf([ed(S2, 'a.ts'), term(S2)]), active_session: S2 },
      },
    });
    const patch = unionToProfile(s, [PA, PB]);
    expect(patch.layout_mode).toBe('profile');
    expect(patch.project_layouts).toEqual({});
    // PA leads, so PB's duplicate of a.ts is pruned; structures sit side by side
    expect(keys(patch.layout_tree!)).toEqual([
      tabRefKey(term(S1)),
      tabRefKey(ed(S2, 'a.ts')),
      tabRefKey(term(S2)),
    ]);
    expect(patch.active_session).toBe(S2);
  });

  it('appends slices missing from the order and survives an empty record', () => {
    const s = snap({
      layout_mode: 'project',
      project_layouts: { [PB]: { layout_tree: makeLeaf([term(S2)]), active_session: S2 } },
    });
    // PB is not in the order — its slice still joins the union
    expect(keys(unionToProfile(s, [PA]).layout_tree!)).toEqual([tabRefKey(term(S2))]);
    const empty = unionToProfile(snap({ layout_mode: 'project' }), [PA]);
    expect(flattenTabs(empty.layout_tree!)).toEqual([]);
    expect(empty.active_session).toBeNull();
  });
});

describe('joinTrees', () => {
  it('keeps each tree as a row sibling and drops emptied ones', () => {
    const joined = joinTrees([makeLeaf([term(S1)]), makeLeaf([term(S1)]), makeLeaf([term(S2)])]);
    // the middle tree emptied by dedupe contributes no pane
    expect(joined.kind).toBe('split');
    expect(keys(joined)).toEqual([tabRefKey(term(S1)), tabRefKey(term(S2))]);
  });

  it('returns a lone tree without a wrapping split and an empty leaf for none', () => {
    const only = makeLeaf([term(S1)]);
    expect(joinTrees([only])).toEqual(only);
    expect(flattenTabs(joinTrees([]))).toEqual([]);
  });
});

describe('scopedSnapshot', () => {
  it('reads the project slice and blanks the profile-wide legacy fields', () => {
    const s = snap({
      layout_tree: makeLeaf([term(S1)]),
      active_session: S1,
      session_tabs: [S1],
      editor_tabs: [{ session: S1, path: 'a.ts' }],
      layout_mode: 'project',
      project_layouts: { [PB]: { layout_tree: makeLeaf([term(S2)]), active_session: S2 } },
    });
    const scoped = scopedSnapshot(s, PB);
    expect(keys(scoped.layout_tree!)).toEqual([tabRefKey(term(S2))]);
    expect(scoped.active_session).toBe(S2);
    expect(scoped.session_tabs).toEqual([]);
    expect(scoped.editor_tabs).toEqual([]);
    // a project with no slice yet is a fresh empty workspace
    const fresh = scopedSnapshot(s, PA);
    expect(fresh.layout_tree).toBeNull();
    expect(fresh.active_session).toBeNull();
  });
});

describe('scopeUiState', () => {
  const handle = (initial: UiStateSnapshot) => {
    let current = initial;
    const base: UiStateHandle = {
      loaded: true,
      snapshot: initial,
      current: () => current,
      update: (patch) => {
        current = { ...current, ...patch };
      },
    };
    return { base, state: () => current };
  };

  it('is the base handle itself when disabled', () => {
    const { base } = handle(snap({}));
    expect(scopeUiState(base, PA, false)).toBe(base);
  });

  it('routes layout keys into the slice and passes the rest through', () => {
    const { base, state } = handle(snap({ layout_mode: 'project' }));
    const scoped = scopeUiState(base, PA, true);
    const tree = makeLeaf([term(S1)]);
    scoped.update({ layout_tree: tree, sidebar_collapsed: true });
    expect(state().layout_tree).toBeNull(); // top level untouched
    expect(state().project_layouts[PA]!.layout_tree).toEqual(tree);
    expect(state().sidebar_collapsed).toBe(true);
  });

  it('merges same-tick updates through current() instead of clobbering', () => {
    const { base, state } = handle(snap({ layout_mode: 'project' }));
    const scoped = scopeUiState(base, PA, true);
    const tree = makeLeaf([term(S1)]);
    scoped.update({ layout_tree: tree });
    scoped.update({ active_session: S1 });
    expect(state().project_layouts[PA]).toEqual({ layout_tree: tree, active_session: S1 });
  });
});
