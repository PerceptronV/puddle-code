import { UserRound } from 'lucide-react';
import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import { cn } from '../../lib/utils';

/**
 * A profile-icon colour key (`Profile.icon_colour`) → the `text-*` class the
 * glyph wears. Every value is a theme-aware token (SPEC §11/§12), so the glyph
 * recolours with the theme and introduces no raw colours; an unknown/absent key
 * falls back to the default heading colour (empty class = inherit).
 */
export const PROFILE_ICON_COLOUR_CLASS: Record<string, string> = {
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

/** A same-size, invisible stand-in shown while a named icon lazy-loads. */
function GlyphSpacer() {
  return <span className="inline-block size-4 shrink-0" aria-hidden />;
}

/**
 * A profile's chosen glyph in its chosen theme colour (SPEC §11). A null icon
 * renders the person glyph directly (no lazy load for the default), a named
 * lucide icon lazy-loads via DynamicIcon behind a same-size spacer, and an
 * unknown name falls back to that spacer.
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
  const cls = cn('size-4 shrink-0', profileColourClass(colour), className);
  if (!icon) return <UserRound className={cls} />;
  return <DynamicIcon name={icon as IconName} fallback={GlyphSpacer} className={cls} />;
}
