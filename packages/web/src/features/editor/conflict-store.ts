/**
 * Saves the daemon REFUSED because the file moved on disk under the buffer
 * (409 `stale_file`, SPEC §8) — one per buffer, held until it is reconciled.
 *
 * A refused save is not an error to dismiss, it is a question to answer: two
 * versions of the file exist and only the person editing knows which parts of
 * each to keep. So the conflict is state, not a toast: the source editor renders
 * the disk version beside the buffer while it stands (`ConflictView`), a save
 * made after seeing it EXPECTS the disk mtime recorded here — that is what makes
 * a merged save land rather than 409 forever — and it clears when the file is
 * reloaded, overwritten, or saved.
 *
 * Monaco-free (plain data + listeners), so the 409 path, the view, and the save
 * rule all read one source of truth.
 */
export interface DiskConflict {
  /** The file's content as it is on disk now — the version the save collided with. */
  content: string;
  /** That content's mtime: what a reconciled save must expect. */
  mtimeMs: number;
}

const conflicts = new Map<string, DiskConflict>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function setConflict(key: string, conflict: DiskConflict): void {
  conflicts.set(key, conflict);
  notify(key);
}

export function clearConflict(key: string): void {
  if (!conflicts.delete(key)) return;
  notify(key);
}

export function conflictFor(key: string): DiskConflict | null {
  return conflicts.get(key) ?? null;
}

/** Subscribe to one buffer's conflict state — shaped for `useSyncExternalStore`. */
export function subscribeConflict(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}
