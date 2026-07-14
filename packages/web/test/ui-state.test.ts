import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { debounce } from '../src/lib/debounce';

describe('uiStateSnapshotSchema', () => {
  it('fills defaults for an empty snapshot', () => {
    expect(uiStateSnapshotSchema.parse({})).toEqual({
      session_tabs: [],
      active_session: null,
      editor_tabs: [],
      layout: {},
      explorer_pin: null,
    });
  });

  it('round-trips a full snapshot through JSON', () => {
    const id = '3b241101-e2bb-4255-8caf-4136c566a962';
    const snapshot = uiStateSnapshotSchema.parse({
      session_tabs: [id],
      active_session: id,
      editor_tabs: [{ session: id, path: 'src/index.ts' }],
      layout: { sidebar: 260, main: 980 },
      explorer_pin: null,
    });
    expect(uiStateSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('preserves unknown keys so later phases extend without migrations', () => {
    const parsed = uiStateSnapshotSchema.parse({ future_pane: { open: true } });
    expect((parsed as Record<string, unknown>)['future_pane']).toEqual({ open: true });
  });

  it('rejects non-uuid session tabs', () => {
    expect(uiStateSnapshotSchema.safeParse({ session_tabs: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once with the last arguments after the delay', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d('first');
    vi.advanceTimersByTime(1000);
    d('second');
    vi.advanceTimersByTime(1999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith('second');
  });

  it('flush runs a pending call immediately, and only once', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d('state');
    d.flush();
    expect(fn).toHaveBeenCalledExactlyOnceWith('state');
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush and cancel are no-ops with nothing pending', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d.flush();
    d.cancel();
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });

  it('cancel drops the pending call', () => {
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d('state');
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
