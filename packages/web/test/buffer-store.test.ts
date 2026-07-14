/**
 * Pure-logic tests for the buffer store (SPEC §8 editor tabs).
 *
 * `monaco-editor` cannot initialise under vitest's node environment (it
 * reaches for `window` at module load — verified locally: importing it here
 * throws `ReferenceError: window is not defined`), so the monaco-touching
 * half of buffer-store.ts (getOrCreateModel, replaceContent, disposeModel —
 * anything that creates or edits a real ITextModel) has no automated
 * coverage here and must be exercised manually in the browser (see the task
 * report for the manual-verification checklist). What IS pure — saved-version
 * bookkeeping and the tab-label collision rule — lives in `buffer-logic.ts`
 * and is fully covered below without touching monaco at all.
 */
import { describe, expect, it } from 'vitest';
import { SavedStateMap, editorTabLabel, type OpenTab } from '../src/features/editor/buffer-logic';

describe('editorTabLabel', () => {
  it('returns the plain basename when it is unique across open tabs', () => {
    const tabs: OpenTab[] = [{ session: 's1', path: 'src/api.ts' }];
    const branches = new Map([['s1', 'main']]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts');
  });

  it('suffixes both tabs with their branch when two sessions share a basename', () => {
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's2', path: 'lib/api.ts' },
    ];
    const branches = new Map([
      ['s1', 'main'],
      ['s2', 'alice/fix-auth'],
    ]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts — main');
    expect(editorTabLabel('lib/api.ts', 's2', tabs, branches)).toBe('api.ts — alice/fix-auth');
  });

  it('falls back to the plain basename when the colliding session has no known branch', () => {
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's2', path: 'lib/api.ts' },
    ];
    const branches = new Map([['s2', 'alice/fix-auth']]); // s1 unknown
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts');
  });

  it('disambiguates two same-session, same-basename tabs by full path (branch would be identical)', () => {
    // Same session, two different files that happen to share a basename.
    // A branch suffix would be identical for both and wouldn't disambiguate,
    // so this falls back to the full path instead — documented choice.
    const tabs: OpenTab[] = [
      { session: 's1', path: 'src/api.ts' },
      { session: 's1', path: 'lib/api.ts' },
    ];
    const branches = new Map([['s1', 'main']]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('src/api.ts');
    expect(editorTabLabel('lib/api.ts', 's1', tabs, branches)).toBe('lib/api.ts');
  });

  it('ignores the tab itself when scanning for collisions', () => {
    // Only one (session, path) tab open — must not "collide" with itself.
    const tabs: OpenTab[] = [{ session: 's1', path: 'src/api.ts' }];
    const branches = new Map([['s1', 'main']]);
    expect(editorTabLabel('src/api.ts', 's1', tabs, branches)).toBe('api.ts');
  });
});

describe('SavedStateMap', () => {
  it('reports not-dirty for a key with no recorded baseline', () => {
    const saved = new SavedStateMap();
    expect(saved.isDirty('k', 5)).toBe(false);
  });

  it('is dirty once the current version diverges from the saved baseline', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    expect(saved.isDirty('k', 1)).toBe(false); // untouched since save
    expect(saved.isDirty('k', 2)).toBe(true); // edited since save
  });

  it('clears dirty state when marked saved again at the new version', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    expect(saved.isDirty('k', 2)).toBe(true);
    saved.mark('k', 2, 2_000);
    expect(saved.isDirty('k', 2)).toBe(false);
  });

  it('tracks saved mtime per key', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    expect(saved.mtime('k')).toBe(1_000);
    expect(saved.mtime('unknown')).toBeUndefined();
  });

  it('lists exactly the dirty keys given each key current version', () => {
    const saved = new SavedStateMap();
    saved.mark('a', 1, 1_000);
    saved.mark('b', 1, 1_000);
    saved.mark('c', 1, 1_000);
    const currentVersions = new Map([
      ['a', 1], // untouched
      ['b', 2], // edited
      ['c', 3], // edited
    ]);
    expect(saved.dirtyKeys(currentVersions)).toEqual(['b', 'c']);
  });

  it('forgets a key on delete', () => {
    const saved = new SavedStateMap();
    saved.mark('k', 1, 1_000);
    saved.delete('k');
    expect(saved.mtime('k')).toBeUndefined();
    expect(saved.isDirty('k', 99)).toBe(false);
  });
});
