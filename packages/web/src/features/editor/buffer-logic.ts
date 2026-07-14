/**
 * Pure logic backing the shared buffer store (SPEC §8): saved-version
 * bookkeeping and the editor-tab label rule. Deliberately monaco-free so it
 * is unit-testable under vitest — `monaco-editor` cannot initialise outside
 * a browser (it reaches for `window` at import time), so anything that
 * touches a real `ITextModel` lives in `buffer-store.ts` instead, behind the
 * lazy editor boundary. This module has no such restriction and may be
 * imported eagerly if ever useful, though today only `buffer-store.ts` does.
 */

/** One open editor tab, identified by (session, path) per SPEC §8. */
export interface OpenTab {
  session: string;
  path: string;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Tab label for `path` open under `session`, given every other currently
 * open tab and a session → branch lookup (SPEC §8: `api.ts — alice/fix-auth`
 * when the same basename is open from more than one worktree).
 *
 * Two collision shapes, which COMPOSE (a basename can collide both ways at
 * once):
 *  - Cross-session: same basename open under a different session (almost
 *    always a different worktree/branch) → suffix with this tab's session
 *    branch, which disambiguates the sessions.
 *  - Same-session: two different paths under ONE session happen to share a
 *    basename (e.g. `src/api.ts` and `lib/api.ts` both open in one tab
 *    strip). Both tabs share the same branch, so a branch suffix alone
 *    cannot disambiguate — the label body becomes the full path instead,
 *    mirroring how editors show a parent directory when two same-named
 *    files are open side by side.
 * When both shapes apply (s1 has `src/api.ts` + `lib/api.ts` open while s2
 * has `other/api.ts`), the s1 tabs get path AND branch —
 * `src/api.ts — main` vs `lib/api.ts — main` — so every label stays unique.
 */
export function editorTabLabel(
  path: string,
  session: string,
  allTabs: readonly OpenTab[],
  sessionBranches: ReadonlyMap<string, string>,
): string {
  const base = basename(path);
  const collisions = allTabs.filter(
    (tab) => !(tab.session === session && tab.path === path) && basename(tab.path) === base,
  );
  if (collisions.length === 0) return base;

  const sameSession = collisions.some((tab) => tab.session === session);
  const crossSession = collisions.some((tab) => tab.session !== session);

  const body = sameSession ? path : base;
  const branch = crossSession ? sessionBranches.get(session) : undefined;
  return branch ? `${body} — ${branch}` : body;
}

interface SavedState {
  versionId: number;
  mtimeMs: number;
}

/**
 * Per-key saved-version/mtime bookkeeping, keyed by whatever string identity
 * the caller uses for (session, path) — `buffer-store.ts` composes this with
 * real monaco `ITextModel.getAlternativeVersionId()` values; tests pass
 * fabricated version numbers directly.
 */
export class SavedStateMap {
  private readonly saved = new Map<string, SavedState>();

  mark(key: string, versionId: number, mtimeMs: number): void {
    this.saved.set(key, { versionId, mtimeMs });
  }

  mtime(key: string): number | undefined {
    return this.saved.get(key)?.mtimeMs;
  }

  /** No baseline recorded yet ⇒ nothing to compare against ⇒ not dirty. */
  isDirty(key: string, currentVersionId: number): boolean {
    const state = this.saved.get(key);
    return state !== undefined && currentVersionId !== state.versionId;
  }

  delete(key: string): void {
    this.saved.delete(key);
  }

  /** Keys whose current version (per the supplied map) diverges from saved. */
  dirtyKeys(currentVersionIds: ReadonlyMap<string, number>): string[] {
    return [...this.saved.keys()].filter((key) => {
      const current = currentVersionIds.get(key);
      return current !== undefined && this.isDirty(key, current);
    });
  }
}
