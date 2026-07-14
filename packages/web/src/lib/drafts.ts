/**
 * Browser-cached editor drafts (SPEC §11 "Reload semantics") — IndexedDB
 * persistence for unsaved editor content, independent of the daemon and of
 * any particular window. A draft records the dirty content plus the disk
 * mtime it was captured against (`base_mtime_ms`); restore policy is the
 * CALLER's (Task 7 wires the actual restore-on-open/tab-restore pass) —
 * this module only stores and retrieves:
 *   - `base_mtime_ms === <current disk mtime>` → the file has not moved
 *     under the draft since it was written; the caller may restore it
 *     silently as a dirty buffer.
 *   - disk mtime has moved (the daemon, another window, or the agent wrote
 *     a newer version) → the caller must NOT clobber the file; offer the
 *     draft via a toast instead.
 *
 * Eager-safe: no monaco, no `features/editor/*` import — this module loads
 * before the editor's lazy boundary (Task 4) so a draft can be captured (via
 * `draftWriter`) even in a window where the editor chunk never loads.
 *
 * Every export is promise-based and best-effort: IndexedDB failures (quota,
 * private browsing, older Safari, or simply absent — this repo's vitest
 * environment has no `indexedDB` global, verified empirically) are swallowed
 * to a `console.warn` plus a safe fallback (`null` / `[]` / resolved
 * `void`). A draft-store outage must never interrupt editing.
 */
import { debounce, type Debounced } from './debounce';

const DB_NAME = 'puddle-drafts';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';
const SESSION_INDEX = 'by_session';
const WRITE_DEBOUNCE_MS = 1000;

export interface Draft {
  session: string;
  path: string;
  content: string;
  base_mtime_ms: number;
  updated_at: number;
}

/**
 * Composite primary key for the `drafts` store — same scheme as `bufferKey`
 * (buffer-store.ts). Exported because it's the one pure piece of this
 * module: no IndexedDB is needed to verify it never collides across
 * sessions/paths that share a delimiter.
 */
export function draftKey(session: string, path: string): string {
  return `${encodeURIComponent(session)}:${encodeURIComponent(path)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB is unavailable in this environment'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME);
        store.createIndex(SESSION_INDEX, 'session', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
  });
}

/** Opens the db, runs `fn` against the drafts store in a transaction of `mode`, then closes it. */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = await fn(store);
    await txDone(tx);
    return result;
  } finally {
    db.close();
  }
}

export async function saveDraft(
  session: string,
  path: string,
  content: string,
  baseMtimeMs: number,
): Promise<void> {
  const draft: Draft = {
    session,
    path,
    content,
    base_mtime_ms: baseMtimeMs,
    updated_at: Date.now(),
  };
  try {
    await withStore('readwrite', (store) => reqDone(store.put(draft, draftKey(session, path))));
  } catch (e) {
    console.warn(`saveDraft failed: ${(e as Error).message}`);
  }
}

export async function loadDraft(session: string, path: string): Promise<Draft | null> {
  try {
    const result = await withStore<Draft | undefined>('readonly', (store) =>
      reqDone(store.get(draftKey(session, path))),
    );
    return result ?? null;
  } catch (e) {
    console.warn(`loadDraft failed: ${(e as Error).message}`);
    return null;
  }
}

export async function deleteDraft(session: string, path: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => reqDone(store.delete(draftKey(session, path))));
  } catch (e) {
    console.warn(`deleteDraft failed: ${(e as Error).message}`);
  }
}

/** Every draft for `session` — used for a tab-restore pass on project open. */
export async function listDrafts(session: string): Promise<Draft[]> {
  try {
    const result = await withStore<Draft[]>('readonly', (store) =>
      reqDone(store.index(SESSION_INDEX).getAll(IDBKeyRange.only(session))),
    );
    return result ?? [];
  } catch (e) {
    console.warn(`listDrafts failed: ${(e as Error).message}`);
    return [];
  }
}

/** Drops every draft for `session` — call when the session is archived (wiring is later). */
export async function deleteSessionDrafts(session: string): Promise<void> {
  try {
    await withStore('readwrite', async (store) => {
      const keys = await reqDone(store.index(SESSION_INDEX).getAllKeys(IDBKeyRange.only(session)));
      await Promise.all(keys.map((key) => reqDone(store.delete(key))));
    });
  } catch (e) {
    console.warn(`deleteSessionDrafts failed: ${(e as Error).message}`);
  }
}

/**
 * A debounced (~1 s) writer for one (session, path): call it on every edit
 * with the latest content and disk mtime; `flush()` to write immediately
 * (e.g. before closing the tab), `cancel()` to drop a pending write (e.g.
 * after a successful save has already called `deleteDraft`).
 */
export function draftWriter(
  session: string,
  path: string,
): Debounced<[content: string, baseMtimeMs: number]> {
  return debounce((content: string, baseMtimeMs: number) => {
    void saveDraft(session, path, content, baseMtimeMs);
  }, WRITE_DEBOUNCE_MS);
}
