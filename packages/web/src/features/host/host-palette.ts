import { isCustomColour } from '../../lib/appearance/appearance-colours';
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

function luminance(hex: string): number {
  return [1, 3, 5].reduce((sum, start, i) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
  }, 0);
}

/** Bound both text legibility and surface separation, including black/white accents. */
function withContrast(colour: string, backgrounds: string[], ink: string, floor = 4.5): string {
  const backdrop = backgrounds.map(luminance);
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(colour, ink, 1 - step / 100);
    const light = luminance(candidate);
    if (
      backdrop.every((bg) => (Math.max(light, bg) + 0.05) / (Math.min(light, bg) + 0.05) >= floor)
    ) {
      return candidate;
    }
  }
  return ink;
}

/** Whole-chrome palette. Semantic statuses, explicit identities and ANSI hues stay independent. */
export function hostPalette(
  colour: string,
  theme: ThemeName,
  read: TokenReader,
): Record<string, string> {
  const token = ACCENT_TOKENS[colour];
  const custom = isCustomColour(colour);
  if (!token && !custom) return {};
  const accent = custom ? colour : read(token!);
  const black = read('--host-shade');
  const white = read('--host-paper');
  const dark = theme === 'dark';
  const ground = dark ? black : white;
  let primary = dark ? mix(accent, white, 0.18) : mix(accent, black, 0.45);
  let secondary = dark ? mix(accent, white, 0.4) : mix(accent, black, 0.65);
  let selection = dark ? accent : mix(accent, black, 0.75);
  let muted = dark ? mix(accent, white, 0.55) : mix(primary, white, 0.76);
  // Keep the default reading surface: white in light mode, deep navy in dark.
  // Island depth is shared by pane frames and sidebars; nested trays step once
  // further in the same direction. A neutral foundation also gives white/black
  // custom accents visible depth without a pane-specific contrast algorithm.
  const base = read('--bg-base');
  const ink = dark ? white : black;
  const foundation = mix(ink, base, dark ? 0.08 : 0.06);
  const tintedSurface = mix(accent, foundation, dark ? 0.13 : 0.05);
  const tintedElevated = mix(tintedSurface, ink, dark ? 0.92 : 0.96);
  // Keep accent depth halfway between the original theme and the full tint.
  const surface = mix(tintedSurface, read('--bg-surface'), 0.5);
  const elevated = mix(tintedElevated, read('--bg-elevated'), 0.5);
  const tray = mix(tintedElevated, read('--bg-tray'), 0.5);
  const backgrounds = [ground, base, surface, elevated, tray];
  const border = withContrast(mix(accent, tray, 0.3), backgrounds, ink, 1.5);
  primary = withContrast(primary, backgrounds, ink);
  secondary = withContrast(secondary, backgrounds, ink);
  muted = withContrast(muted, backgrounds, ink);
  selection = withContrast(selection, backgrounds, ink);
  return {
    '--bg-surface': surface,
    '--bg-elevated': elevated,
    '--bg-tray': tray,
    '--border': border,
    '--text-primary': primary,
    '--text-secondary': secondary,
    '--text-muted': muted,
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
