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

/**
 * The slice of a monaco `ITextModel` `applyDraft` needs — kept structural (and
 * generic over the model's range type `R`) so this stays monaco-free and
 * unit-testable: `buffer-store.ts` passes a real `ITextModel` (where `R` is
 * `monaco.Range`), tests pass a fake that records the edit.
 */
export interface DraftApplicableModel<R> {
  getValue(): string;
  getFullModelRange(): R;
  pushEditOperations(
    beforeCursorState: null,
    editOperations: { range: R; text: string }[],
    cursorStateComputer: () => null,
  ): unknown;
}

/**
 * Lays a restored draft on top of a model whose saved baseline is the disk
 * content (SPEC §11 reload semantics). The model must already hold the disk
 * content with `markSaved` recorded against it; a single full-range
 * `pushEditOperations` then swaps in the draft content so the edit lands on
 * the undo stack and the model reads as *dirty* relative to the saved
 * baseline (a plain `setValue` would reset the model and lose that dirty
 * signal). Returns whether an edit was pushed — a draft identical to disk is
 * a no-op and the buffer stays clean. `pushEditOperations` (not `setValue`)
 * for the same undo-history reason as `buffer-store.ts`'s `replaceContent`.
 */
export function applyDraft<R>(model: DraftApplicableModel<R>, draftContent: string): boolean {
  if (model.getValue() === draftContent) return false;
  model.pushEditOperations(
    null,
    [{ range: model.getFullModelRange(), text: draftContent }],
    () => null,
  );
  return true;
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
