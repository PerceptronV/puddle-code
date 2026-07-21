import { UserRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { PROFILE_ICON_BY_NAME } from './profile-icons';

/**
 * A profile-icon colour key (`Profile.icon_colour`) → the `text-*` class the
 * glyph wears. Every value is a theme-aware token (SPEC §11/§12), so the glyph
 * recolours with the theme and introduces no raw colours; an unknown/absent key
 * falls back to the default heading colour (empty class = inherit).
 */
export const PROFILE_ICON_COLOUR_CLASS: Record<string, string> = {
  // Storm-navy in light, near-white in dark — the theme-aware primary ink.
  navy: 'text-fg',
  gold: 'text-fg-gold',
  blue: 'text-icon-blue',
  green: 'text-icon-green',
  amber: 'text-icon-amber',
  red: 'text-icon-red',
  violet: 'text-icon-violet',
  cyan: 'text-icon-cyan',
  accent: 'text-accent',
};

export function profileColourClass(colour: string | null | undefined): string {
  return (colour && PROFILE_ICON_COLOUR_CLASS[colour]) || '';
}

/**
 * A profile's chosen glyph in its chosen theme colour (SPEC §11). The icon comes
 * from the curated, statically-imported set (`profile-icons.ts`) — no lazy
 * loading — so an absent or unrecognised name falls back to the person glyph.
 */
export function ProfileGlyph({
  icon,
  colour,
  className,
}: {
  icon: string | null | undefined;
  colour: string | null | undefined;
  className?: string;
}) {
  // No chosen colour → a neutral grey glyph (the "Default" swatch), NOT the
  // navy heading ink; `navy` is its own explicit choice.
  const cls = cn(
    'size-4 shrink-0',
    colour ? profileColourClass(colour) : 'text-fg-muted',
    className,
  );
  const Icon = (icon && PROFILE_ICON_BY_NAME[icon]) || UserRound;
  return <Icon className={cls} />;
}
