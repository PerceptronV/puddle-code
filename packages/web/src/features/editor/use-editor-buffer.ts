import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../../lib/api';
import type { Debounced } from '../../lib/debounce';
import { deleteDraft, draftWriter, loadDraft } from '../../lib/drafts';
import { useSaveWorktreeFile, useWorktreeFile } from '../../lib/worktree-queries';
import {
  applyDraft,
  bufferKey,
  getOrCreateModel,
  isDirty,
  markSaved,
  replaceContent,
  savedMtime,
  subscribe,
} from './buffer-store';
import {
  announceDraftUpdated,
  announceSaved,
  clearPeerState,
  peerState,
  subscribePeerState,
} from './editor-sync';
import { monaco } from './monaco-setup';
import type { RevealTarget } from '../workspace/editor-context';

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
  save(): void;
  /** Wire into `<Editor onMount>` — binds ⌘S and the reveal-on-open caret. */
  onMount(editor: monaco.editor.IStandaloneCodeEditor): void;
}

/**
 * The conflict-safe editing state for one (session, path) tab (SPEC §8/§11):
 * shared-model creation, draft restore, dirty tracking, the save / 409 /
 * overwrite flow, cross-window peer sync, and the clean-refocus refresh. Kept
 * out of `CodeEditor.tsx` so that file stays a thin view under the ~300-line
 * guidance. Behind the lazy editor boundary — imports the buffer store, which
 * imports monaco.
 */
export function useEditorBuffer(
  session: string,
  path: string,
  reveal: RevealTarget | null,
): EditorBuffer {
  const key = bufferKey(session, path);
  const file = useWorktreeFile(session, path);
  const saveMutation = useSaveWorktreeFile(session);

  const [model, setModel] = useState<monaco.editor.ITextModel | null>(null);
  const [restoredNotice, setRestoredNotice] = useState(false);
  const createdRef = useRef(false);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const writerRef = useRef<Debounced<[content: string, baseMtimeMs: number]> | null>(null);
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
    (content: string, mtimeMs: number) => {
      writerRef.current?.cancel();
      reloadingRef.current = true;
      try {
        replaceContent(key, content, mtimeMs);
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

  // Create the shared model once the file content arrives, then lay any draft
  // on top of the disk baseline. A model that already exists (tab reactivated,
  // or the diff view opened it) is reused untouched — never re-draft it.
  useEffect(() => {
    const data = file.data;
    if (!data || data.binary || data.content === null || createdRef.current) return;
    createdRef.current = true;
    const existedBefore = savedMtime(key) !== undefined;
    const created = getOrCreateModel(session, path, data.content, data.mtime_ms);
    setModel(created);
    if (existedBefore) return;
    void loadDraft(session, path).then((draft) => {
      if (!draft) return;
      if (draft.base_mtime_ms === data.mtime_ms) {
        // The file has not moved under the draft — restore it as dirty edits.
        if (applyDraft(created, draft.content)) setRestoredNotice(true);
      } else {
        // The disk content moved on: keep it clean, offer the draft instead.
        toast('This file has an unsaved draft from an earlier version.', {
          description: 'The file changed on disk since the draft was saved.',
          duration: 12_000,
          action: {
            label: 'Restore draft',
            onClick: () => {
              if (applyDraft(created, draft.content)) setRestoredNotice(true);
            },
          },
        });
      }
    });
  }, [file.data, key, session, path]);

  // Persist edits to a browser draft (debounced) and tell peer windows.
  useEffect(() => {
    if (!model) return;
    const writer = draftWriter(session, path);
    writerRef.current = writer;
    const sub = model.onDidChangeContent(() => {
      if (reloadingRef.current) return; // disk reload, not a user edit
      writer(model.getValue(), savedMtime(key) ?? 0);
      announceDraftUpdated(session, path);
    });
    return () => {
      writer.flush();
      sub.dispose();
      writerRef.current = null;
    };
  }, [model, key, session, path]);

  // A peer saved this file: if we are clean, silently adopt the new disk
  // content; if we are dirty, leave it and show a passive badge instead.
  useEffect(() => {
    if (!model || !peer.savedElsewhere || isDirty(key)) return;
    void file.refetch().then((res) => {
      if (res.data && res.data.content !== null) {
        reloadModel(res.data.content, res.data.mtime_ms);
      }
      clearPeerState(key);
    });
    // file.refetch identity is stable enough; keyed on the signal + model.
  }, [peer.savedElsewhere, model, key]);

  // Clean-refocus refresh: a background refetch (window focus) brought a newer
  // disk mtime while we are clean — adopt it so agent edits stay visible
  // without file watching. A no-op right after load/save (mtimes match).
  useEffect(() => {
    const data = file.data;
    if (!model || !data || data.content === null) return;
    if (!isDirty(key) && data.mtime_ms !== savedMtime(key)) {
      reloadModel(data.content, data.mtime_ms);
    }
  }, [file.data, model, key]);

  const commitSaved = useCallback(
    (versionId: number, mtimeMs: number) => {
      markSaved(key, versionId, mtimeMs);
      writerRef.current?.cancel();
      void deleteDraft(session, path);
      announceSaved(session, path, mtimeMs);
      setRestoredNotice(false);
    },
    [key, session, path],
  );

  const reload = useCallback(() => {
    void file.refetch().then((res) => {
      if (res.data && res.data.content !== null) {
        reloadModel(res.data.content, res.data.mtime_ms);
      }
      void deleteDraft(session, path);
      setRestoredNotice(false);
    });
  }, [key, session, path, reloadModel]);

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

  const save = useCallback(() => {
    if (!model || !isDirty(key)) return;
    const content = model.getValue();
    const versionId = model.getAlternativeVersionId();
    saveMutation.mutate(
      { path, content, expected_mtime_ms: savedMtime(key) },
      {
        onSuccess: (res) => commitSaved(versionId, res.mtime_ms),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409 && err.code === 'stale_file') {
            toast.error('File changed on disk (probably the agent)', {
              duration: Infinity,
              action: { label: 'Reload', onClick: () => reload() },
              cancel: { label: 'Overwrite', onClick: () => overwrite(content, versionId) },
            });
          } else {
            toast.error(err instanceof Error ? err.message : 'Save failed');
          }
        },
      },
    );
  }, [model, key, saveMutation, path, commitSaved, reload, overwrite]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const applyReveal = useCallback(() => {
    const ed = editorRef.current;
    const r = revealRef.current;
    if (!ed || !r || r.session !== session || r.path !== path) return;
    ed.revealLineInCenter(r.line);
    ed.setPosition({ lineNumber: r.line, column: r.column ?? 1 });
    ed.focus();
  }, [session, path]);

  const onMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor;
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
      applyReveal();
    },
    [applyReveal],
  );

  useEffect(() => {
    applyReveal();
  }, [reveal, model, applyReveal]);

  const discardRestore = useCallback(() => {
    reload();
  }, [reload]);

  // Derive the view status. A 413 from the daemon is "file_too_large".
  let status: BufferStatus;
  let errorMessage: string | null = null;
  if (file.data?.binary) {
    status = 'binary';
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
    save,
    onMount,
  };
}
