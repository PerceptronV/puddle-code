/** Shared profile/project palette, entirely derived from the active theme. */
const COLOUR_CLASSES: Record<string, string> = {
  navy: 'text-identity-navy',
  gold: 'text-identity-gold',
  blue: 'text-icon-blue',
  green: 'text-icon-green',
  amber: 'text-icon-amber',
  red: 'text-icon-red',
  violet: 'text-icon-violet',
  cyan: 'text-icon-cyan',
  accent: 'text-accent',
};

/** Unknown or unset keys inherit the surrounding label's usual styling. */
export function appearanceColourClass(colour: string | null | undefined): string {
  return (colour && COLOUR_CLASSES[colour]) || '';
}

/** Explicit user colours are kept separate from theme-derived preset classes. */
export function isCustomColour(colour: string | null | undefined): colour is string {
  return typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour);
}

export function appearanceColourStyle(colour: string | null | undefined) {
  return isCustomColour(colour) ? { color: colour } : undefined;
}
