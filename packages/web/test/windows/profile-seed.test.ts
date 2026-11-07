import { describe, expect, it } from 'vitest';
import { uiStateSnapshotSchema, type LayoutLeaf, type DesktopProfileSeed } from '@puddle/shared';
import { desktopProfileSeed } from '../../src/features/windows/profile-seed';
import { flattenTabs } from '../../src/features/workspace/layout/layout-tree';

const profileId = '1234567890';
const projectId = 'abcdef1234';
const terminal = (id: string): LayoutLeaf => ({
  kind: 'leaf',
  id,
  tabs: [{ type: 'terminal', session: id }],
  activeKey: `term:${id}`,
});

describe('complete desktop profile seed', () => {
  it('keeps source and detached tabs together without duplicating an existing view', () => {
    const base = uiStateSnapshotSchema.parse({ sidebar_collapsed: true });
    base.layout_tree = terminal('source');
    const detached = uiStateSnapshotSchema.parse({});
    detached.layout_tree = terminal('detached');
    const seed: DesktopProfileSeed = {
      base,
      detached: [
        { identity: { id: 'project', kind: 'project', profileId, projectId }, snapshot: detached },
        { identity: { id: 'pane', kind: 'pane', profileId, projectId }, snapshot: detached },
      ],
    };
    const result = desktopProfileSeed(seed);
    expect(flattenTabs(result.layout_tree!)).toEqual([
      { type: 'terminal', session: 'source' },
      { type: 'terminal', session: 'detached' },
    ]);
    expect(result.sidebar_collapsed).toBe(true);
    expect(flattenTabs(base.layout_tree!)).toHaveLength(1);
  });

  it('merges detached panes into their project while retaining other project slices', () => {
    const base = uiStateSnapshotSchema.parse({ layout_mode: 'project' });
    base.project_layouts[projectId] = {
      layout_tree: terminal('source'),
      active_session: null,
      layout_ref: null,
    };
    base.project_layouts['0000000000'] = {
      layout_tree: terminal('unrelated'),
      active_session: null,
      layout_ref: 12,
    };
    const detached = uiStateSnapshotSchema.parse({});
    detached.layout_tree = terminal('detached');
    const result = desktopProfileSeed({
      base,
      detached: [
        { identity: { id: 'pane', kind: 'pane', profileId, projectId }, snapshot: detached },
      ],
    });
    expect(flattenTabs(result.project_layouts[projectId]!.layout_tree!)).toHaveLength(2);
    expect(result.project_layouts['0000000000']).toEqual(base.project_layouts['0000000000']);
    expect(base.project_layouts[projectId]!.layout_tree).toEqual(terminal('source'));
  });
});
