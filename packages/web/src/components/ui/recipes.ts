/**
 * Shared surface recipes (HUMANS.md). Components compose these instead of
 * hand-rolling classes, so a styling decision changes in exactly one place.
 *
 * - Fields: a fill that dims on hover/focus — no border, no focus outline
 *   (app.css removes the outline for text fields; the fill shift is the cue).
 * - Menu rows: highlight is the ink action fill, never the accent blue.
 */

export const fieldSurface =
  'rounded-md bg-elevated text-sm text-fg placeholder:text-fg-muted transition-colors hover:bg-border/50 focus:bg-border/50 disabled:cursor-not-allowed disabled:opacity-50';

export const menuRow =
  'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg outline-none transition-colors';

/* Radix (dropdown-menu, select) and cmdk expose different state attributes. */
export const menuHighlightRadix =
  'data-[highlighted]:bg-action data-[highlighted]:text-action-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
export const menuHighlightCmdk =
  'data-[selected=true]:bg-action data-[selected=true]:text-action-ink data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50';
