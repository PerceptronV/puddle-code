import type { ThemeName, TokenReader } from '../../lib/appearance/theme';

/** Blend resolved palette colours into hex, also understood by Monaco and xterm. */
function mix(a: string, b: string, weight: number): string {
  const bytes = (hex: string) =>
    [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  const other = bytes(b);
  return (
    '#' +
    bytes(a)
      .map((value, i) =>
        Math.round(value * weight + other[i]! * (1 - weight))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

const ACCENT_TOKENS: Record<string, string> = {
  navy: '--identity-navy',
  gold: '--identity-gold',
  blue: '--ansi-blue',
  green: '--ansi-green',
  red: '--ansi-red',
  violet: '--ansi-magenta',
  cyan: '--ansi-cyan',
};

/** Whole-chrome palette. Semantic statuses, explicit identities and ANSI hues stay independent. */
export function hostPalette(
  colour: string,
  theme: ThemeName,
  read: TokenReader,
): Record<string, string> {
  const token = ACCENT_TOKENS[colour];
  if (!token) return {};
  const accent = read(token);
  const black = read('--host-shade');
  const white = read('--host-paper');
  const dark = theme === 'dark';
  const ground = dark ? black : white;
  const primary = dark ? mix(accent, white, 0.18) : mix(accent, black, 0.45);
  const secondary = dark ? mix(accent, white, 0.4) : mix(accent, black, 0.65);
  const selection = dark ? accent : mix(accent, black, 0.75);
  const base = dark ? mix(accent, ground, 0.055) : white;
  return {
    '--bg-base': base,
    '--bg-surface': mix(accent, ground, dark ? 0.105 : 0.025),
    '--bg-elevated': mix(accent, ground, dark ? 0.16 : 0.065),
    '--bg-tray': mix(accent, ground, dark ? 0.16 : 0.04),
    '--border': mix(accent, ground, dark ? 0.28 : 0.14),
    '--text-primary': primary,
    '--text-secondary': secondary,
    '--text-muted': dark ? mix(accent, white, 0.55) : mix(primary, white, 0.76),
    '--text-gold': selection,
    '--explorer-foreground': primary,
    '--explorer-folder': primary,
    '--accent': selection,
    '--accent-hover': primary,
    '--focus-ring': selection,
    '--nav-selection': selection,
    '--nav-selection-ink': ground,
    '--action': primary,
    '--action-hover': secondary,
    '--action-ink': ground,
    '--selection': selection + (dark ? '4d' : '33'),
    '--explorer-selection': selection + '2e',
    '--explorer-hover': selection + '0d',
  };
}
