import './overlay-motion.css';

/**
 * Shared surface recipes (HUMANS.md). Components compose these instead of
 * hand-rolling classes, so a styling decision changes in exactly one place.
 *
 * - Fields: a fill that dims on hover/focus — no border, no focus outline
 *   (app.css removes the outline for text fields; the fill shift is the cue).
 * - Menu rows: highlight is the ink action fill, never the accent blue.
 */

/* Default fields retain their border-derived fill. Accented fields use the
   lighter file-hover fill independently of the stronger island outlines. */
export const fieldSurface =
  'rounded-[var(--ui-radius)] bg-border/50 text-sm text-fg placeholder:text-fg-muted transition-colors hover:bg-border/80 focus:bg-border/80 host-accent:bg-explorer-hover host-accent:hover:bg-explorer-selection/50 host-accent:focus:bg-explorer-selection/50 disabled:cursor-not-allowed disabled:opacity-50';

export const menuRow =
  'relative flex cursor-pointer select-none items-center gap-2 rounded-[var(--ui-menu-radius)] px-2 py-1.5 text-sm text-fg outline-none transition-colors';

/* Radix (dropdown-menu, select) and cmdk expose different state attributes. */
export const menuHighlightRadix =
  'data-[highlighted]:bg-action data-[highlighted]:text-action-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
export const menuHighlightCmdk =
  'data-[selected=true]:bg-action data-[selected=true]:text-action-ink data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50';

/** Shared floating surface; compact overlays keep a smaller rounded inset. */
export const overlaySurface = 'overlay-surface rounded-[var(--ui-surface-radius)] bg-elevated';
export const overlayMotion = 'overlay-content-motion';
export const menuSurface = `${overlaySurface} ${overlayMotion} p-1`;
export const compactOverlaySurface = 'overlay-surface rounded-[var(--ui-radius)] bg-elevated';

/** Unfilled single actions, also usable inside a shared tray. */
export const compactAction =
  'inline-flex size-[var(--ui-control-height)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--ui-radius)] text-fg transition-colors hover:bg-elevated disabled:pointer-events-none disabled:opacity-50';
export const textAction =
  'cursor-pointer rounded-[var(--ui-menu-radius)] px-1 py-0.5 text-xs text-fg transition-colors hover:bg-elevated';
