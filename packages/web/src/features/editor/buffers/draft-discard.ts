import { draftKey } from '../../../lib/persistence/drafts';

const writers = new Map<string, Set<() => void>>();

/** Cancel local pending writes before an approved discard deletes the stored draft. */
export function onDraftDiscard(
  session: string,
  path: string,
  root: string | undefined,
  cancel: () => void,
): () => void {
  const key = draftKey(session, path, root);
  const pending = writers.get(key) ?? new Set();
  writers.set(key, pending);
  pending.add(cancel);
  return () => {
    pending.delete(cancel);
    if (!pending.size) writers.delete(key);
  };
}

export function cancelDiscardedDraftWrites(session: string, path: string, root?: string): void {
  for (const cancel of writers.get(draftKey(session, path, root)) ?? []) cancel();
}
