import { beforeEach, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { desktopContentState } from '../../src/features/windows/content-state';
import { ViewStateStore } from '../../src/features/editor/tabs/view-state-store';

const mode = vi.hoisted(() => ({ desktop: true }));
vi.mock('../../src/features/profile/profile-store', () => ({
  currentProfileId: () => '1234567890',
}));
vi.mock('../../src/features/windows/window-context', () => ({
  desktopWindowContext: () => (mode.desktop ? {} : null),
}));
const content = desktopContentState('1234567890');
beforeEach(() => {
  mode.desktop = true;
  content.restore({ snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} });
});

it('uses an adopted desktop position instead of the renderer cache from before detachment', () => {
  const store = new ViewStateStore<number>(10, 'code');
  store.set('pane', 3);
  content.restore({
    snapshot: uiStateSnapshotSchema.parse({}),
    buffers: [],
    views: { 'code:pane': 27 },
  });
  expect(store.get('pane')).toBe(27);
  content.restore({ snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} });
  expect(store.get('pane')).toBeUndefined();
});

it('retains ordinary browser view caching without desktop state', () => {
  mode.desktop = false;
  const store = new ViewStateStore<number>(10, 'code');
  store.set('pane', 12);
  expect(store.get('pane')).toBe(12);
  expect(content.view('code:pane')).toBeUndefined();
});
