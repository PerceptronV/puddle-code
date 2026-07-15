/**
 * Pure ordering for the sessions sidebar (SPEC §8). The list is user-orderable
 * by drag; this applies the persisted order (`ui_state.session_order`) and puts
 * any session NOT in that order at the top, newest-first — so a freshly created
 * session always appears on top until the user drags it. Session-type-agnostic:
 * it keys purely on `id`, so agent and terminal sessions order the same way.
 * Side-effect-free and DOM-free — unit-testable.
 */
import type { Session } from '@puddle/shared';

/** Milliseconds an item was created, for the newest-first default. */
function createdMs(item: { created_at: string }): number {
  const ms = Date.parse(item.created_at);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Orders `items` by the saved `order` (an array of ids). Items present in
 * `order` follow its sequence; items absent from it (new, or never-dragged when
 * `order` is empty) come first, newest-created first. Id-keyed and generic — the
 * sessions sidebar and the homescreen's projects share it.
 */
export function orderByDrag<T extends { id: string; created_at: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const known: T[] = [];
  const unknown: T[] = [];
  for (const item of items) {
    (rank.has(item.id) ? known : unknown).push(item);
  }
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  unknown.sort((a, b) => createdMs(b) - createdMs(a));
  return [...unknown, ...known];
}

/** Orders sessions by the saved `session_order` — see {@link orderByDrag}. */
export function orderSessions(sessions: readonly Session[], order: readonly string[]): Session[] {
  return orderByDrag(sessions, order);
}

/**
 * Moves `dragId` to sit immediately before `beforeId` within `orderedIds` (the
 * current visible order), returning the full new id order to persist. A no-op
 * when the ids match or either is missing.
 */
export function reorderIds(
  orderedIds: readonly string[],
  dragId: string,
  beforeId: string,
): string[] {
  if (dragId === beforeId) return [...orderedIds];
  const next = orderedIds.filter((id) => id !== dragId);
  const at = next.indexOf(beforeId);
  if (at === -1) return [...orderedIds];
  next.splice(at, 0, dragId);
  return next;
}
