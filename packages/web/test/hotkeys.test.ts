import { describe, expect, it } from 'vitest';
import { formatBinding, HOTKEY_ACTIONS, shellDefaultBinding } from '../src/lib/hotkeys';

const byId = (id: string) => HOTKEY_ACTIONS.find((a) => a.id === id)!;

describe('shellDefaultBinding', () => {
  it('forks the intuitive natives on desktop and keeps the web-safe set in a tab', () => {
    expect(shellDefaultBinding(byId('tab.close'), true)).toBe('meta+KeyW');
    expect(shellDefaultBinding(byId('tab.close'), false)).toBe('ctrl+alt+KeyW');
    expect(shellDefaultBinding(byId('sidebar.left'), true)).toBe('meta+KeyB');
    expect(shellDefaultBinding(byId('session.newAgent'), true)).toBe('meta+KeyT');
    // an action without a desktop fork uses the one default everywhere
    expect(shellDefaultBinding(byId('palette.toggle'), true)).toBe('meta+KeyK');
    expect(shellDefaultBinding(byId('palette.toggle'), false)).toBe('meta+KeyK');
  });

  it('neither default set contains an internal conflict', () => {
    for (const desktop of [false, true]) {
      const bindings = HOTKEY_ACTIONS.map((a) => shellDefaultBinding(a, desktop));
      expect(new Set(bindings).size).toBe(bindings.length);
    }
  });

  it('desktop forks format to the intended Mac glyphs', () => {
    expect(formatBinding(shellDefaultBinding(byId('tab.close'), true))).toBe('⌘W');
    expect(formatBinding(shellDefaultBinding(byId('sidebar.left'), true))).toBe('⌘B');
    expect(formatBinding(shellDefaultBinding(byId('session.newAgent'), true))).toBe('⌘T');
  });
});
