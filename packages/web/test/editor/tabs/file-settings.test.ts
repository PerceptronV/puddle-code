import { describe, expect, it } from 'vitest';
import {
  FileSettingsStore,
  fileSettingsKey,
} from '../../../src/features/editor/settings/file-settings-store';

describe('file editor overrides', () => {
  it('isolates hosts, roots, sessions and draft profiles while sharing file/diff views', () => {
    const tab = { session: 'session-a', path: 'src/main.ts' };
    const key = fileSettingsKey('host-a', 'profile-a', tab);
    expect(fileSettingsKey('host-a', 'profile-a', { ...tab, kind: 'diff' })).toBe(key);
    for (const other of [
      fileSettingsKey('host-b', 'profile-a', tab),
      fileSettingsKey('host-a', 'profile-a', { ...tab, root: '/other' }),
      fileSettingsKey('host-a', 'profile-a', { ...tab, session: 'session-b' }),
    ])
      expect(other).not.toBe(key);
    expect(fileSettingsKey('host-a', 'profile-a', { ...tab, kind: 'untitled' })).not.toBe(
      fileSettingsKey('host-a', 'profile-b', { ...tab, kind: 'untitled' }),
    );
  });

  it('resets one inherited option without losing others and bounds retained overrides', () => {
    const store = new FileSettingsStore(2);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.update('a', { tabSize: 8, wordWrap: false, language: 'python' });
    store.update('a', { wordWrap: undefined });
    expect(store.get('a')).toEqual({ tabSize: 8, wordWrap: undefined, language: 'python' });
    store.update('b', { wordWrap: true });
    store.update('c', { tabSize: 4 });
    expect(store.get('a')).toEqual({});
    expect(store.get('b').wordWrap).toBe(true);
    expect(notifications).toBe(4);
    unsubscribe();
    store.update('b', { wordWrap: undefined });
    expect(store.get('b')).toBe(store.get('missing'));
    expect(notifications).toBe(4);
  });
});
