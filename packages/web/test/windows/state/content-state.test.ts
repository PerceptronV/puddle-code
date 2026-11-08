import { describe, expect, it } from 'vitest';
import { uiStateSnapshotSchema, type DesktopBufferSnapshot } from '@puddle/shared';
import { DesktopContentState } from '../../../src/features/windows/state/content-state';

const buffer: DesktopBufferSnapshot = {
  session: 'session',
  path: 'a.ts',
  content: 'unsaved',
  baseMtimeMs: 1,
};
const empty = () => ({ snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} });

describe('desktop content handoff seam', () => {
  it('keeps dirty content after an inactive editor view unmounts', () => {
    const state = new DesktopContentState();
    state.restore(empty());
    const release = state.registerBuffer(buffer, () => buffer);
    release();
    expect(state.capture().buffers).toEqual([buffer]);
  });

  it('does not recapture a moved source buffer during React cleanup', () => {
    const state = new DesktopContentState();
    state.restore({ ...empty(), buffers: [buffer] });
    const release = state.registerBuffer(buffer, () => buffer);
    state.restore(empty());
    expect(state.capture(uiStateSnapshotSchema.parse({})).buffers).toEqual([]);
    release();
    expect(state.capture().buffers).toEqual([]);
  });

  it('retains unloaded recovery drafts and removes a now-clean live buffer', () => {
    const state = new DesktopContentState();
    const other = { ...buffer, path: 'not-loaded.ts' };
    state.restore({ ...empty(), buffers: [buffer, other] });
    state.registerBuffer(buffer, () => null);
    expect(state.capture().buffers).toEqual([other]);
  });

  it('does not recapture a moved model from an inactive historical layout tree', () => {
    const state = new DesktopContentState();
    const moved = { ...buffer, session: '00000000-0000-4000-8000-000000000001' };
    state.restore({ ...empty(), buffers: [moved] });
    const release = state.registerBuffer(moved, () => moved);
    const snapshot = uiStateSnapshotSchema.parse({
      layout_mode: 'project',
      // This tree is retained across layout-mode switches but is not live.
      layout_tree: {
        kind: 'leaf',
        id: 'old',
        activeKey: null,
        tabs: [{ type: 'editor', tab: { session: moved.session, path: moved.path } }],
      },
    });
    state.restore({ snapshot, buffers: [], views: {} });
    expect(state.capture(snapshot).buffers).toEqual([]);
    release();
    expect(state.capture().buffers).toEqual([]);
  });
});
