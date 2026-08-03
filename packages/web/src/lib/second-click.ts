/**
 * Finder-style click-to-rename gating (SPEC §8, §12): a single click on an
 * already-active item starts an inline rename ONLY when the previous click on
 * that same item was recent — a click on something selected ages ago behaves
 * like any other click (toggle a folder, navigate to a project) rather than
 * surprising the user with an edit field. Pure and DOM-free.
 */

export interface ClickStamp {
  id: string;
  at: number;
}

/** How long after a click a follow-up click still reads as "rename me". */
export const SECOND_CLICK_WINDOW_MS = 1500;

/** Whether a click at `now` on `id` is a rename-intent second click. */
export function isSecondClick(prev: ClickStamp | null, id: string, now: number): boolean {
  return prev !== null && prev.id === id && now - prev.at < SECOND_CLICK_WINDOW_MS;
}
