import { describe, expect, it } from 'vitest';
import { monacoThemeFrom, xtermThemeFrom, type TokenReader } from '../src/lib/theme';

/** Reader that echoes the token name so mappings are directly assertable. */
const echo: TokenReader = (token) => `<${token}>`;

describe('xtermThemeFrom', () => {
  const theme = xtermThemeFrom(echo);

  it('maps chrome tokens onto the terminal', () => {
    expect(theme.background).toBe('<--bg-base>');
    expect(theme.foreground).toBe('<--text-primary>');
    expect(theme.cursor).toBe('<--accent>');
    expect(theme.selectionBackground).toBe('<--selection>');
  });

  it('maps all sixteen ANSI slots', () => {
    expect(theme.red).toBe('<--ansi-red>');
    expect(theme.brightMagenta).toBe('<--ansi-bright-magenta>');
    const slots = Object.values(theme);
    expect(slots).toHaveLength(21); // 16 ANSI + bg/fg/cursor/cursorAccent/selection
    expect(new Set(slots).size).toBe(20); // cursorAccent deliberately reuses --bg-base
  });
});

describe('monacoThemeFrom', () => {
  const hex: TokenReader = () => '#7dadff';

  it('picks the matching monaco base theme', () => {
    expect(monacoThemeFrom(hex, 'dark').base).toBe('vs-dark');
    expect(monacoThemeFrom(hex, 'light').base).toBe('vs');
  });

  it('emits bare RRGGBB for token rules and #-prefixed colours for the chrome', () => {
    const theme = monacoThemeFrom(hex, 'dark');
    for (const rule of theme.rules) {
      expect(rule.foreground).toBe('7dadff');
    }
    expect(theme.colors['editor.background']).toBe('#7dadff');
    expect(theme.colors['focusBorder']).toBe('#7dadff');
  });
});
