import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { desktopContentState } from '../../../src/features/windows/state/content-state';
import { ViewStateStore } from '../../../src/features/editor/tabs/view-state-store';

const mode = vi.hoisted(() => ({ desktop: true }));
vi.mock('../../../src/features/profile/profile-store', () => ({
  currentProfileId: () => '1234567890',
}));
vi.mock('../../../src/features/windows/window-context', () => ({
  desktopWindowContext: () => (mode.desktop ? {} : null),
}));
const content = desktopContentState('1234567890');
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
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

it('copies authoritative desktop view keys without reading editor buffers', () => {
  const store = new ViewStateStore<number>(10, 'huddle');
  store.set('source', 1);
  content.restore({
    snapshot: uiStateSnapshotSchema.parse({}),
    buffers: [],
    views: { 'huddle:source': 25 },
  });
  const read = vi.fn(() => null);
  content.registerBuffer({ session: 'session', path: 'file' }, read);
  store.copyKeys((key) => (key === 'source' ? 'destination' : undefined));
  expect(store.get('destination')).toBe(25);
  expect(read).not.toHaveBeenCalled();
});

it('bounds opted-in browser recovery, flushes on pagehide and preserves separate pane keys', () => {
  mode.desktop = false;
  vi.useFakeTimers();
  const data = new Map<string, string>();
  const events = new EventTarget();
  vi.stubGlobal('window', events);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
  vi.stubGlobal('sessionStorage', storage);
  const store = new ViewStateStore<number>(2, 'huddle', true);
  store.set('old', 1);
  store.set('left', 2);
  store.set('right', 3);
  expect(storage.setItem).not.toHaveBeenCalled();
  events.dispatchEvent(new Event('pagehide'));
  expect(storage.setItem).toHaveBeenCalledOnce();
  const restored = new ViewStateStore<number>(2, 'huddle', true);
  expect(restored.get('old')).toBeUndefined();
  expect(restored.get('left')).toBe(2);
  expect(restored.get('right')).toBe(3);
  restored.copyKeys((key) => (key === 'left' ? 'moved' : undefined));
  expect(restored.get('moved')).toBe(2);
  vi.advanceTimersByTime(250);
  expect(JSON.parse(data.get('puddle.views.huddle')!)).toHaveLength(2);
});

it('tolerates corrupt and unavailable browser storage', () => {
  mode.desktop = false;
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('sessionStorage', {
    getItem: () => '{',
    setItem: () => {
      throw new Error('quota');
    },
  });
  const store = new ViewStateStore<number>(2, 'huddle', true);
  expect(store.get('pane')).toBeUndefined();
  store.set('pane', 7);
  expect(() => vi.advanceTimersByTime(250)).not.toThrow();
  expect(store.get('pane')).toBe(7);
});
