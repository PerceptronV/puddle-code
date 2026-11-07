import { describe, expect, it } from 'vitest';
import { uiStateSnapshotSchema, type DesktopBufferSnapshot } from '@puddle/shared';
import { DesktopContentState } from '../../src/features/windows/content-state';

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
});
