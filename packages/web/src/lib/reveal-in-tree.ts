/**
 * "Show me where that file lives": one request, made by a list that names a path
 * — a search hit, a changed file — and honoured by the Files tree, which expands
 * every ancestor directory of the path, selects the row, and scrolls it into
 * view (SPEC §8).
 *
 * It is a module-level LATCH rather than a callback prop because the two ends are
 * never mounted together: the left sidebar shows ONE navigator at a time, so a
 * path clicked in Search or Changes is asking a tree that does not exist yet.
 * The request is therefore kept until a tree claims it — which is exactly the
 * behaviour a user wants, since the reveal is what they will find when they open
 * Files next. Clicking a path never yanks the sidebar off their results to prove
 * it happened.
 *
 * The request carries the worktree root it is relative to (`root`, undefined for
 * a session's own worktree, matching `?root=` everywhere else), so a browse tree
 * rooted somewhere else ignores a request that would resolve to a different file.
 */
export interface RevealRequest {
  /** Root-relative path (a file or a directory). */
  path: string;
  /** The `?root=` this path belongs to; undefined for the session's worktree. */
  root?: string | undefined;
}

let pending: RevealRequest | null = null;
const listeners = new Set<(request: RevealRequest) => void>();

/** Ask the Files tree to reveal `path`. Kept until a mounted tree takes it. */
export function requestReveal(request: RevealRequest): void {
  pending = request;
  // A mounted tree consumes it synchronously via `takePendingReveal`.
  listeners.forEach((l) => l(request));
}

/**
 * Subscribe to reveal requests. On subscribing, any request made while no tree
 * was mounted is delivered immediately — that is the whole point of the latch.
 */
export function onReveal(listener: (request: RevealRequest) => void): () => void {
  listeners.add(listener);
  if (pending) listener(pending);
  return () => listeners.delete(listener);
}

/** Clear the latch once a tree has acted on it, so it fires once and not again. */
export function clearPendingReveal(): void {
  pending = null;
}
