/**
 * Shared model/buffer store (SPEC §8) — the heart of Phase 3's editing UX.
 * One monaco `ITextModel` per (session, path); the editor tab and the diff
 * tab's modified side share the SAME model, so edits and dirty state are
 * never duplicated between the two views.
 *
 * Imports `monaco` from `monaco-setup.ts`, so — like that module — this one
 * lives entirely behind the lazy editor boundary; nothing eager may import
 * it. The saved-version bookkeeping and tab-label rule are pure and live in
 * `buffer-logic.ts` (re-exported here for the public contract) so they stay
 * unit-testable without monaco, which cannot initialise under vitest.
 */
import { monaco } from './monaco-setup';
import { SavedStateMap, applyDraft, editorTabLabel, type OpenTab } from './buffer-logic';

export { applyDraft, editorTabLabel, type OpenTab };

/** Stable identity for a (session, path) pair — the store's map key. */
export function bufferKey(session: string, path: string): string {
  return `${encodeURIComponent(session)}:${encodeURIComponent(path)}`;
}

/** `puddle://<session>/<path>`, with every path segment percent-encoded. */
function modelUri(session: string, path: string): monaco.Uri {
  const segments = path.split('/').map(encodeURIComponent);
  return monaco.Uri.parse(`puddle://${encodeURIComponent(session)}/${segments.join('/')}`);
}

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : ''; // dot > 0: a leading-dot file (.gitignore) has no "extension"
}

/** Best-effort language id from the path's extension; 'plaintext' otherwise. */
function languageForPath(path: string): string {
  const ext = extensionOf(path);
  if (!ext) return 'plaintext';
  const match = monaco.languages.getLanguages().find((lang) => lang.extensions?.includes(ext));
  return match?.id ?? 'plaintext';
}

interface Entry {
  model: monaco.editor.ITextModel;
  disposable: monaco.IDisposable;
}

const entries = new Map<string, Entry>();
const savedState = new SavedStateMap();

const keyListeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();

function notify(key: string): void {
  for (const listener of keyListeners.get(key) ?? []) listener();
  for (const listener of globalListeners) listener();
}

/**
 * Subscribe to dirty-state changes for one key — compatible with
 * `useSyncExternalStore`. Fires on content edits and on `markSaved`/
 * `replaceContent` (which flip dirty state without necessarily editing
 * content again).
 */
export function subscribe(key: string, listener: () => void): () => void {
  let set = keyListeners.get(key);
  if (!set) {
    set = new Set();
    keyListeners.set(key, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

/** Subscribe to ANY buffer's dirty-state changes (e.g. a "listDirty" badge). */
export function subscribeAny(listener: () => void): () => void {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

/**
 * Returns the model for (session, path), creating it from `content` on
 * first use. An already-open (possibly dirty) buffer is returned untouched —
 * a background re-fetch must never clobber in-progress edits.
 */
export function getOrCreateModel(
  session: string,
  path: string,
  content: string,
  mtimeMs: number,
): monaco.editor.ITextModel {
  const key = bufferKey(session, path);
  const existing = entries.get(key);
  if (existing) return existing.model;

  const uri = modelUri(session, path);
  const model =
    monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageForPath(path), uri);
  const disposable = model.onDidChangeContent(() => notify(key));
  entries.set(key, { model, disposable });
  savedState.mark(key, model.getAlternativeVersionId(), mtimeMs);
  return model;
}

/** Records `versionId` (from `model.getAlternativeVersionId()`) as saved. */
export function markSaved(key: string, versionId: number, mtimeMs: number): void {
  if (!entries.has(key)) return;
  savedState.mark(key, versionId, mtimeMs);
  notify(key); // dirty flag can flip with no further content change
}

export function savedMtime(key: string): number | undefined {
  return savedState.mtime(key);
}

export function isDirty(key: string): boolean {
  const entry = entries.get(key);
  if (!entry) return false;
  return savedState.isDirty(key, entry.model.getAlternativeVersionId());
}

/**
 * Reload-from-disk: replaces the model's full content and resets saved
 * state to the new (versionId, mtimeMs). Uses `pushEditOperations` (a single
 * full-range edit) rather than `setValue` so the edit lands on the model's
 * own undo stack — undo can still step back through it. `setValue` would
 * instead reset the model's undo/redo history outright, which would also
 * discard undo for any edits made before the reload; `pushEditOperations`
 * keeps history "surviving where practical" at the cost of one extra
 * keystroke of undo to get past the reload itself.
 */
export function replaceContent(key: string, content: string, mtimeMs: number): void {
  const entry = entries.get(key);
  if (!entry) return;
  const { model } = entry;
  // Identical content ⇒ skip the edit (it would only push a no-op undo
  // entry); still re-baseline saved state, since the disk mtime moved.
  if (model.getValue() !== content) {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
  }
  savedState.mark(key, model.getAlternativeVersionId(), mtimeMs);
  notify(key);
}

/** Disposes the model and forgets all bookkeeping for `key`. */
export function disposeModel(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.disposable.dispose();
  entry.model.dispose();
  entries.delete(key);
  savedState.delete(key);
  keyListeners.delete(key);
}

/** Every key with unsaved edits, across all open buffers. */
export function listDirty(): string[] {
  const currentVersions = new Map(
    [...entries].map(([key, entry]) => [key, entry.model.getAlternativeVersionId()]),
  );
  return savedState.dirtyKeys(currentVersions);
}
