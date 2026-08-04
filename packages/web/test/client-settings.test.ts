import { describe, expect, it } from 'vitest';
import { reconcileProjectScopeSettings } from '../src/lib/client-settings';

/**
 * Project-based layout and the session list's scope were ONE setting through
 * v0.0.24. Splitting them must not flip either behaviour under a stored
 * snapshot, in either direction.
 */
describe('reconcileProjectScopeSettings', () => {
  it('seeds the layout setting from a pre-projectBasedLayout snapshot', () => {
    expect(reconcileProjectScopeSettings({ showAllProjectSessions: false })).toEqual({
      showAllProjectSessions: false,
      projectBasedLayout: true,
    });
    expect(reconcileProjectScopeSettings({ showAllProjectSessions: true })).toEqual({
      showAllProjectSessions: true,
      projectBasedLayout: false,
    });
  });

  it('seeds the sidebar setting from a v0.0.22–v0.0.24 snapshot, keeping what that window showed', () => {
    // project-based layout used to scope the sidebar too: keep it scoped.
    expect(reconcileProjectScopeSettings({ projectBasedLayout: true })).toEqual({
      projectBasedLayout: true,
      showAllProjectSessions: false,
    });
    expect(reconcileProjectScopeSettings({ projectBasedLayout: false })).toEqual({
      projectBasedLayout: false,
      showAllProjectSessions: true,
    });
  });

  it('leaves an already-split snapshot alone, including the mixes only it can express', () => {
    // per-project layout WITH every project's sessions listed — the combination
    // the coupled setting could not express, and the reason for the split.
    const mixed = { projectBasedLayout: true, showAllProjectSessions: true };
    expect(reconcileProjectScopeSettings(mixed)).toEqual(mixed);
    const inverse = { projectBasedLayout: false, showAllProjectSessions: false };
    expect(reconcileProjectScopeSettings(inverse)).toEqual(inverse);
  });

  it('passes an empty snapshot through, so the defaults decide', () => {
    expect(reconcileProjectScopeSettings({})).toEqual({});
    // and it never touches unrelated keys
    expect(reconcileProjectScopeSettings({ uiFontSize: 18 })).toEqual({ uiFontSize: 18 });
  });
});
