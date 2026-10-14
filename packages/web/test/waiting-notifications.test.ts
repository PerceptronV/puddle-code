import { describe, expect, it } from 'vitest';
import { decideNotification } from '../src/features/shell/use-waiting-notifications';

const prefs = (over = {}) => ({
  desktop: true,
  sound: true,
  when_focused: true,
  muted_projects: [] as string[],
  ...over,
});

describe('decideNotification', () => {
  it('notifies focused windows by default and honours background-only delivery', () => {
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        windowFocused: false,
        permission: 'granted',
      }),
    ).toEqual({ desktop: true, sound: true });
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        windowFocused: true,
        permission: 'granted',
      }),
    ).toEqual({ desktop: true, sound: true });
    expect(
      decideNotification({
        prefs: prefs({ when_focused: false }),
        projectId: 'p1',
        windowFocused: true,
        permission: 'granted',
      }),
    ).toEqual({ desktop: false, sound: true });
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        windowFocused: true,
        permission: 'unverified',
      }),
    ).toEqual({ desktop: true, sound: true });
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        windowFocused: false,
        permission: 'denied',
      }),
    ).toEqual({ desktop: false, sound: true });
  });

  it('a muted project silences both channels', () => {
    expect(
      decideNotification({
        prefs: prefs({ muted_projects: ['p1'] }),
        projectId: 'p1',
        windowFocused: false,
        permission: 'granted',
      }),
    ).toEqual({ desktop: false, sound: false });
  });

  it('respects the per-channel toggles', () => {
    expect(
      decideNotification({
        prefs: prefs({ desktop: false, sound: false }),
        projectId: 'p1',
        windowFocused: false,
        permission: 'granted',
      }),
    ).toEqual({ desktop: false, sound: false });
  });
});
