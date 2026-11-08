import { onDraftDiscard } from './draft-discard';
import { useFileEditorSettings } from '../settings/file-editor-settings';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../../../lib/transport/api';
import type { Debounced } from '../../../lib/debounce';
import {
  deleteDraft,
  draftDisposition,
  draftWriter,
  loadDraft,
} from '../../../lib/persistence/drafts';
import { useBufferTransport } from './use-buffer-transport';
import {
  restoreHuddleDraftBaseline,
  sameHuddleDraftBaseline,
  type HuddleDraftBaseline,
} from '@puddle/shared';
import {
  applyDraft,
  bufferKey,
  getOrCreateModel,
  isDirty,
  markSaved,
  replaceContent,
  savedMtime,
  savedRevision,
  restoreSavedBaseline,
  subscribe,
} from './buffer-store';
import {
  announceDraftUpdated,
  announceSaved,
  clearPeerState,
  peerState,
  subscribePeerState,
} from './editor-sync';
import {
  beginComparison,
  clearConflict,
  comparedMtime,
  completeComparison,
  comparisonLocksBuffer,
  conflictFor,
  failComparison,
  finishOpeningComparison,
  registerConflict,
  shouldOfferComparison,
  subscribeConflict,
  type DiskConflict,
} from '../conflicts/conflict-store';
import { registerEditorKeybindings } from '../monaco/editor-keybindings';
import { monaco } from '../monaco/monaco-setup';
import { registerSaver, saverKey } from './save-registry';
import type { RevealTarget } from '../../workspace/editor-context';
import { consumeEditorReveal } from '../monaco/editor-reveal';
import { useCurrentProfileId } from '../../profile/profile-store';
import { desktopContentState } from '../../windows/state/content-state';
import { desktopWindowContext } from '../../windows/window-context';

/** What the CodeEditor view renders for a (session, path) tab. */
export type BufferStatus = 'loading' | 'binary' | 'too-large' | 'error' | 'ready';

export interface EditorBuffer {
  status: BufferStatus;
  errorMessage: string | null;
  /** The shared model, once created; null until the file's content has loaded. */
  model: monaco.editor.ITextModel | null;
  dirty: boolean;
  /** "Restored unsaved changes" notice — a draft was laid on top of disk content. */
  restoredNotice: boolean;
  discardRestore(): void;
  /** A passive one-line badge for cross-window activity, or null. */
  peerBadge: 'saved-elsewhere' | 'dirty-elsewhere' | null;
  /** A save the daemon refused because the file moved on disk, until reconciled. */
  conflict: DiskConflict | null;
  /** Resolve a conflict by discarding the buffer and taking the file on disk. */
  takeDisk(): Promise<void>;
  /** Resolve a conflict by writing the buffer over whatever is on disk. */
  keepMine(): void;
  /** Lock the buffer, load the current disk version, and open reconciliation. */
  compare(): void;
  /** Unlock the modified side once Monaco has mounted the comparison. */
  comparisonReady(revision: number): void;
  save(): void;
  /** Wire into `<Editor onMount>` — binds ⌘S and the reveal-on-open caret. */
  onMount(editor: monaco.editor.IStandaloneCodeEditor): void;
}

/**
 * How a view holds the buffer. A READING view (a rendered preview) shows the
 * same buffer without owning the keyboard: it must not write drafts — there is
 * nothing to type into it, and a second writer for one model would persist and
 * announce the same content twice — and it wants the file re-read as it changes
 * on disk, since it has no caret and is often watching an agent write.
 */
export interface BufferOptions {
  /** Read-only holder: no draft writer, no draft-updated announcements. */
  passive?: boolean;
  /** Poll the file so disk changes appear without a window refocus. */
  live?: boolean;
  /** Whether this tab is the workspace's logically focused tab. */
  focused?: boolean;
}

/** One stable Sonner identity per shared buffer, including external roots. */
function conflictToastId(key: string): string {
  return `file-conflict:${key}`;
}

/**
 * The conflict-safe editing state for one (session, path) tab (SPEC §8/§11):
 * shared-model creation, draft restore, dirty tracking, the save / 409 /
 * overwrite flow, cross-window peer sync, and the clean-refocus refresh. Kept
 * out of `CodeEditor.tsx` so that file stays a thin view under the ~300-line
 * guidance. Behind the lazy editor boundary — imports the buffer store, which
 * imports monaco.
 *
 * Both views of a previewable file use it, source and rendered alike (see
 * `BufferOptions`), so they share one model, one dirty flag, and one save.
 */
export function useEditorBuffer(
  session: string,
  path: string,
  reveal: RevealTarget | null,
  /** Absolute browse root of an `external` tab (SPEC §8): keys the buffer,
   * drafts, and peer sync apart from a worktree file with the same relative
   * path, and threads through the file GET/PUT. */
  root?: string,
  opts?: BufferOptions,
): EditorBuffer {
  const passive = opts?.passive === true;
  const profileId = useCurrentProfileId();
  const focused = opts?.focused ?? true;
  const { fileSettingsKey } = useFileEditorSettings();
  const key = bufferKey(session, path, root);
  const { file, saveMutation, guarded } = useBufferTransport(session, path, root, opts?.live);

  const [model, setModel] = useState<monaco.editor.ITextModel | null>(null);
  const [restoredNotice, setRestoredNotice] = useState(false);
  const createdRef = useRef(false);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const writerRef = useRef<Debounced<
    [content: string, baseMtimeMs: number, baseRevision?: HuddleDraftBaseline]
  > | null>(null);
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  // True while a disk-reload edit is in flight. `replaceContent` fires the
  // model's content-change event synchronously (during `pushEditOperations`)
  // *before* it re-marks the saved baseline, so without this guard the
  // draft-writer would see a momentarily-dirty buffer and persist a spurious
  // draft of the freshly-reloaded disk content.
  const reloadingRef = useRef(false);

  /** Adopt fresh disk content, suppressing the draft-writer for the edit. */
  const reloadModel = useCallback(
    (content: string, mtimeMs: number, revision?: HuddleDraftBaseline) => {
      writerRef.current?.cancel();
      reloadingRef.current = true;
      try {
        replaceContent(key, content, mtimeMs, revision);
      } finally {
        reloadingRef.current = false;
      }
    },
    [key],
  );

  const dirty = useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(key, cb), [key]),
    () => isDirty(key),
  );
  const peer = useSyncExternalStore(
    useCallback((cb: () => void) => subscribePeerState(key, cb), [key]),
    () => peerState(key),
  );
  const conflict = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeConflict(key, cb), [key]),
    () => conflictFor(key),
  );

  // Create the shared model once the file content arrives, then lay any draft
  // on top of the disk baseline. A model that already exists (tab reactivated,
  // or the diff view opened it) is reused untouched — never re-draft it.
  useEffect(() => {
    const data = file.data;
    if (!data || data.binary || data.content === null || createdRef.current) return;
    createdRef.current = true;
    const existedBefore = savedMtime(key) !== undefined;
    const transferred =
      profileId && desktopWindowContext()
        ? desktopContentState(profileId).buffer({ session, path, root })
        : undefined;
    const created = getOrCreateModel(
      session,
      path,
      data.content,
      transferred?.baseMtimeMs ?? data.mtime_ms,
      root,
      transferred ? restoreHuddleDraftBaseline(transferred.baseRevision) : data.baseRevision,
    );
    // Capture Monaco's normalised disk baseline before the async IndexedDB
    // read. Reading the live model inside that callback could instead compare
    // the draft with keystrokes entered while the draft was loading.
    const baselineContent = created.getValue();
    setModel(created);
    if (existedBefore) return;
    if (transferred) {
      if (applyDraft(created, transferred.content)) setRestoredNotice(true);
      return;
    }
    void loadDraft(session, path, root).then((draft) => {
      if (!draft) return;
      if (created.isDisposed()) return;
      const disposition = isDirty(key)
        ? 'offer'
        : draftDisposition(draft, baselineContent, data.mtime_ms, data.baseRevision);
      if (disposition === 'discard') {
        // No recoverable edits remain. In particular, do not let an mtime-only
        // rewrite turn this no-op draft into the same stale warning forever.
        void deleteDraft(session, path, root);
      } else if (disposition === 'restore') {
        // The file has not moved under the draft — restore it as dirty edits.
        restoreSavedBaseline(key, draft.base_mtime_ms, draft.baseRevision);
        if (applyDraft(created, draft.content)) setRestoredNotice(true);
      } else {
        // The disk content moved on: keep it clean, offer the draft instead.
        toast('This file has an unsaved draft from an earlier version.', {
          description: 'The file changed on disk since the draft was saved.',
          duration: 12_000,
          action: {
            label: 'Restore draft',
            onClick: () => {
              if (created.isDisposed()) return;
              restoreSavedBaseline(key, draft.base_mtime_ms, draft.baseRevision);
              if (applyDraft(created, draft.content)) setRestoredNotice(true);
            },
          },
        });
      }
    });
  }, [file.data, key, session, path, root, profileId]);

  useEffect(() => {
    if (!profileId || !model || !desktopWindowContext()) return;
    const state = desktopContentState(profileId);
    const identity = { session, path, root };
    const unregister = state.registerBuffer(identity, () => {
      if (model.isDisposed()) return state.buffer(identity) ?? null;
      return isDirty(key)
        ? {
            ...identity,
            content: model.getValue(),
            baseMtimeMs: savedMtime(key) ?? 0,
            ...(savedRevision(key) ? { baseRevision: savedRevision(key) } : {}),
          }
        : null;
    });
    const off = subscribe(key, () => state.bufferChanged(identity));
    state.bufferChanged(identity);
    return () => {
      unregister();
      off();
    };
  }, [profileId, model, key, session, path, root]);

  // Persist edits to a browser draft (debounced) and tell peer windows. A
  // passive holder skips it entirely: it cannot be typed into, and a second
  // writer on one model would persist and announce every edit twice.
  useEffect(() => {
    if (!model || passive) return;
    const writer = draftWriter(session, path, root);
    const stopDiscard = onDraftDiscard(session, path, root, writer.cancel);
    writerRef.current = writer;
    const sub = model.onDidChangeContent(() => {
      if (reloadingRef.current) return; // disk reload, not a user edit
      writer(model.getValue(), savedMtime(key) ?? 0, savedRevision(key));
      announceDraftUpdated(session, path, root);
    });
    return () => {
      stopDiscard();
      writer.flush();
      sub.dispose();
      writerRef.current = null;
    };
  }, [model, key, session, path, root, passive]);

  // A peer saved this file: if we are clean, silently adopt the new disk
  // content; if we are dirty, leave it and show a passive badge instead.
  //
  // Deliberately narrow deps: this must fire exactly when the `savedElsewhere`
  // signal arrives (or once the model exists to receive it), never on `file`'s
  // identity — the query result object changes on every fetch, and including
  // it would re-run the adopt (and re-clear peer state) after its own refetch
  // resolves, looping. `file.refetch` is safe to call from the stale closure:
  // TanStack Query's refetch is a stable reference for a given query key, and
  // this component remounts (new hook instance) whenever (session, path) — and
  // hence the key — changes. `reloadModel` is likewise keyed only on `key`.
  useEffect(() => {
    if (!model || !peer.savedElsewhere || isDirty(key)) return;
    void file.refetch().then((res) => {
      // Re-check dirtiness AFTER the async refetch: the user may have typed
      // while the fetch was in flight. If the buffer is now dirty, keep it —
      // adopting the disk content would clobber those keystrokes. Leaving the
      // peer state set surfaces the passive `saved-elsewhere` badge instead.
      if (isDirty(key)) return;
      if (res.data && res.data.content !== null) {
        reloadModel(res.data.content, res.data.mtime_ms, res.data.baseRevision);
      }
      clearPeerState(key);
    });
  }, [peer.savedElsewhere, model, key]);

  // Clean-refocus refresh: a background refetch (window focus) brought a newer
  // disk mtime while we are clean — adopt it so agent edits stay visible
  // without file watching. A no-op right after load/save (mtimes match).
  useEffect(() => {
    const data = file.data;
    if (!model || !data || data.content === null) return;
    if (
      !isDirty(key) &&
      (data.mtime_ms !== savedMtime(key) ||
        !sameHuddleDraftBaseline(data.baseRevision, savedRevision(key)))
    ) {
      reloadModel(data.content, data.mtime_ms, data.baseRevision);
    }
  }, [file.data, model, key]);

  const commitSaved = useCallback(
    (versionId: number, mtimeMs: number, revision?: HuddleDraftBaseline) => {
      markSaved(key, versionId, mtimeMs, revision);
      writerRef.current?.cancel();
      if (isDirty(key) && model) {
        writerRef.current?.(model.getValue(), mtimeMs, revision);
        writerRef.current?.flush();
      } else void deleteDraft(session, path, root);
      announceSaved(session, path, mtimeMs, root);
      setRestoredNotice(false);
      clearConflict(key); // the write landed: there is nothing left to reconcile
    },
    [key, session, path, root, model],
  );

  const compare = useCallback(() => {
    const revision = beginComparison(key);
    if (revision === null) return;
    toast.dismiss(conflictToastId(key));
    void file
      .refetch({ throwOnError: true })
      .then((res) => {
        const data = res.data;
        if (!data) throw new Error('The disk version did not load.');
        if (data.content === null) {
          throw new Error('The file on disk is binary and cannot be compared as text.');
        }
        completeComparison(
          key,
          revision,
          data.content,
          data.mtime_ms,
          data.baseRevision,
          data.captured,
          savedRevision(key),
          data.repair,
        );
      })
      .catch((error: unknown) => {
        failComparison(
          key,
          revision,
          error instanceof Error ? error.message : 'The disk version did not load.',
        );
      });
  }, [file, key]);

  const compareRef = useRef(compare);
  compareRef.current = compare;

  // A stale save remains an editable buffer until the user asks to compare.
  // The notification is scoped to logical focus: dismissing it stands while the
  // tab stays focused; leaving and returning offers the unresolved question
  // again. Cleanup also prevents a warning for pane A lingering over pane B.
  useEffect(() => {
    if (!shouldOfferComparison(conflict, focused)) return;
    const id = conflictToastId(key);
    toast(conflict?.huddle ? 'Review huddle source before saving' : 'File changed on disk', {
      id,
      description: conflict?.uncertain
        ? 'The save outcome is uncertain. Your draft is retained; inspect source before another save.'
        : 'Your unsaved version is intact. Compare it with the current source.',
      duration: Infinity,
      closeButton: true,
      action: { label: 'Compare', onClick: () => compareRef.current() },
    });
    return () => {
      toast.dismiss(id);
    };
  }, [conflict, focused, key]);

  const reload = useCallback(() => {
    const resolving = conflictFor(key);
    return file
      .refetch({ throwOnError: true })
      .then(async (res) => {
        const data = res.data;
        if (!data || data.content === null)
          throw new Error('The file on disk could not be loaded as text.');
        if (resolving && conflictFor(key)?.revision !== resolving.revision) return;
        // Taking disk is an explicit resolution. A checked, identical PUT
        // acknowledges it to the daemon without rewriting the file. If it has
        // changed again, keep the conflict and the user's buffer intact.
        const accepted =
          resolving && !guarded
            ? await saveMutation.mutateAsync({
                path,
                content: data.content,
                expected_mtime_ms: data.mtime_ms,
              })
            : data;
        if (resolving && conflictFor(key)?.revision !== resolving.revision) return;
        reloadModel(data.content, accepted.mtime_ms, data.baseRevision);
        void deleteDraft(session, path, root);
        setRestoredNotice(false);
        clearConflict(key);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'stale_file') {
          registerConflict(key, { session, path, root });
        } else toast.error(error instanceof Error ? error.message : 'Reload failed');
      });
  }, [key, session, path, root, file, saveMutation, reloadModel, guarded]);

  const overwrite = useCallback(
    (content: string, versionId: number) => {
      saveMutation.mutate(
        { path, content },
        {
          onSuccess: (res) => commitSaved(versionId, res.mtime_ms),
          onError: (err) => toast.error(err instanceof Error ? err.message : 'Overwrite failed'),
        },
      );
    },
    [saveMutation, path, commitSaved],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const conflict = conflictFor(key);
    if (conflict && conflict.phase !== 'comparing') return false;
    if (!model || (!isDirty(key) && !conflict)) return true;
    const content = model.getValue();
    const versionId = model.getAlternativeVersionId();
    // A save made while a conflict stands expects the DISK version's mtime, not
    // the one this buffer loaded: the disk content has been laid beside the
    // buffer and reconciled against, so that version is what the write is based
    // on. Expecting the stale load mtime instead would 409 forever, leaving no
    // way to save a merge at all.
    // Loading/error removes every editable view, but the workspace-level save
    // dispatcher can still address this buffer; never let that bypass the lock.
    if (comparisonLocksBuffer(conflictFor(key))) return false;
    const expected = comparedMtime(conflictFor(key)) ?? savedMtime(key);
    try {
      const res = await saveMutation.mutateAsync({
        path,
        content,
        expected_mtime_ms: expected,
        baseRevision: conflict?.phase === 'comparing' ? conflict.baseRevision : savedRevision(key),
        repairReview: conflict?.phase === 'comparing' && conflict.repair,
      });
      commitSaved(versionId, res.mtime_ms, res.baseRevision);
      return true;
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        ['stale_file', 'huddle_source_changed', 'huddle_definition_invalid'].includes(err.code)
      ) {
        // Nothing was written. Reconciliation is opt-in: keep the buffer
        // editable and offer Compare while this tab is focused. The disk
        // read begins only after that action synchronously locks the model.
        registerConflict(key, { session, path, root }, { huddle: guarded });
      } else {
        if (guarded && !(err instanceof ApiError && err.status < 500))
          registerConflict(key, { session, path, root }, { huddle: true, uncertain: true });
        toast.error(err instanceof Error ? err.message : 'Save failed');
      }
      return false;
    }
  }, [model, key, saveMutation, session, path, root, commitSaved, guarded]);

  const saveRef = useRef(save);
  saveRef.current = save;

  // Publish this buffer's save for ⌘S pressed OUTSIDE Monaco — a focused
  // preview, or a pane focused by its tab chip (`save-registry.ts`). Registered
  // through the ref so re-renders don't churn the registry.
  useEffect(
    () =>
      registerSaver(saverKey(session, path, root), () => saveRef.current(), {
        session,
        path,
        ...(root !== undefined ? { root } : {}),
      }),
    [session, path, root],
  );

  const applyReveal = useCallback(() => {
    const ed = editorRef.current;
    const r = revealRef.current;
    if (
      !ed ||
      !r ||
      !focused ||
      r.session !== session ||
      r.path !== path ||
      (r.root ?? undefined) !== (root ?? undefined)
    ) {
      return;
    }
    if (!consumeEditorReveal(r)) return;
    ed.revealLineInCenter(r.line);
    ed.setPosition({ lineNumber: r.line, column: r.column ?? 1 });
    ed.focus();
  }, [session, path, root, focused]);

  const onMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor;
      registerEditorKeybindings(editor, { onSave: () => saveRef.current(), fileSettingsKey });
      applyReveal();
    },
    [applyReveal, fileSettingsKey],
  );

  useEffect(() => {
    applyReveal();
  }, [reveal, model, applyReveal]);

  const discardRestore = useCallback(() => {
    reload();
  }, [reload]);

  // The two decisive answers to a conflict. `takeDisk` is the ordinary reload —
  // the buffer's edits go, the file on disk wins. Guarded huddle files retain
  // the reviewed revision even for Keep mine; ordinary files may overwrite.
  const keepMine = useCallback(() => {
    if (!model || conflictFor(key)?.phase !== 'comparing') return;
    if (guarded || savedRevision(key)) {
      void saveRef.current();
      return;
    }
    overwrite(model.getValue(), model.getAlternativeVersionId());
  }, [model, key, overwrite, guarded]);

  const comparisonReady = useCallback(
    (revision: number) => {
      finishOpeningComparison(key, revision);
    },
    [key],
  );

  // Derive the view status. A 413 from the daemon is "file_too_large".
  let status: BufferStatus;
  let errorMessage: string | null = null;
  if (file.data?.binary) {
    status = 'binary';
  } else if (guarded && model && dirty) {
    // A failed background read must not hide recoverable, editable text.
    status = 'ready';
  } else if (file.error) {
    if (file.error instanceof ApiError && file.error.status === 413) {
      status = 'too-large';
    } else {
      status = 'error';
      errorMessage = file.error instanceof Error ? file.error.message : 'Failed to load file';
    }
  } else if (model) {
    status = 'ready';
  } else {
    status = 'loading';
  }

  const peerBadge =
    dirty && peer.savedElsewhere
      ? 'saved-elsewhere'
      : dirty && peer.dirtyElsewhere
        ? 'dirty-elsewhere'
        : null;

  return {
    status,
    errorMessage,
    model,
    dirty,
    restoredNotice,
    discardRestore,
    peerBadge,
    conflict,
    takeDisk: reload,
    keepMine,
    compare,
    comparisonReady,
    save,
    onMount,
  };
}
