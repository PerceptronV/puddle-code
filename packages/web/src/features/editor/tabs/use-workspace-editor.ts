import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LatexSynctexResponse } from '@puddle/shared';
import { deleteDraft, loadDraft, saveDraft } from '../../../lib/persistence/drafts';
import { renameEntry } from '../../../lib/queries/worktree-queries';
import { toastError } from '../../../lib/transport/errors';
import { basename, dirOf, joinPath } from '../../explorer/explorer-paths';
import type { EditorTab } from './editor-tabs';
import { previewKind } from '../previews/preview-kind';
import {
  useEditorHandler,
  type EditorPosition,
  type RevealTarget,
} from '../../workspace/editor-context';
import type { LayoutController } from '../../workspace/layout/useLayoutTree';
import type { UiStateHandle } from '../../workspace/use-ui-state';
import { updateWorkspaceTrees } from '../../workspace/layout/update-workspace-trees';
import { useCurrentProfileId } from '../../profile/profile-store';
import { renameBufferTabs } from '../../workspace/layout/layout-tree';

/** Editor opens, source reveals and buffer-identity changes; no editor chunk on initial load. */
export function useWorkspaceEditor({
  layout,
  baseUiState,
  claimScrollDriver,
  onOpen,
}: {
  layout: LayoutController;
  baseUiState: UiStateHandle;
  claimScrollDriver: (leafId: string) => void;
  onOpen: () => void;
}) {
  const qc = useQueryClient();
  const profileId = useCurrentProfileId();
  const profileRef = useRef(profileId);
  profileRef.current = profileId;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Opening any tab from a navigator (files tree, diff list, history list) or a
  // Phase 4 terminal link adds/focuses its editor tab and makes it active —
  // pure ui-state, so it works before the lazy editor chunk loads. A `position`
  // arrives with a fresh nonce so the editor zone reveals the caret even when
  // the same file tab was already open (only meaningful for file tabs).
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const revealCompiledSource = useCallback(
    (leafId: string, target: LatexSynctexResponse) => {
      const sourceLeafId = layoutRef.current.openEditorInLeaf(
        leafId,
        {
          session: target.session,
          path: target.path,
          ...(target.root !== undefined
            ? { kind: 'external' as const, root: target.root }
            : { kind: 'file' as const }),
        },
        { dedupeAcrossTree: true },
      );
      claimScrollDriver(sourceLeafId);
      setReveal({
        session: target.session,
        path: target.path,
        ...(target.root !== undefined ? { root: target.root } : {}),
        line: target.line,
        column: target.column,
        nonce: Date.now(),
      });
    },
    [claimScrollDriver],
  );
  const openEditorTab = useCallback(
    (tab: EditorTab, position?: EditorPosition, opts?: { preview?: boolean }) => {
      const current = layoutRef.current;
      claimScrollDriver(current.focusedLeaf.id);
      current.openEditor(tab, { preview: opts?.preview });
      // On a phone the navigator overlay covers the pane it just opened into.
      onOpen();
      if (position && ['file', 'external'].includes(tab.kind ?? 'file')) {
        setReveal({
          session: tab.session,
          path: tab.path,
          ...(tab.root !== undefined ? { root: tab.root } : {}),
          line: position.line,
          column: position.column,
          nonce: Date.now(),
        });
      }
    },
    [claimScrollDriver, onOpen],
  );
  // Stable file-open handler for terminal links, the explorer, and the editor
  // context (keeps the original `(session, path, position?)` shape). Opens are
  // permanent by default; the explorer opts into preview per single-vs-double
  // click (VSCode-style).
  const openFile = useCallback(
    (
      sessionId: string,
      path: string,
      position?: EditorPosition,
      opts?: { preview?: boolean; view?: 'source' | 'preview'; root?: string },
    ) =>
      openEditorTab(
        {
          // A rooted open is an `external` tab: the path is relative to the
          // browse root, and a `file` tab would resolve it against the
          // WORKTREE (see OpenFileOpts.root).
          ...(opts?.root !== undefined
            ? { kind: 'external' as const, session: sessionId, path, root: opts.root }
            : { kind: 'file' as const, session: sessionId, path }),
          ...(opts?.view
            ? { view: opts.view }
            : !position && previewKind(path) === 'notebook'
              ? { view: 'preview' as const }
              : {}),
        },
        position,
        opts,
      ),
    [openEditorTab],
  );
  useEditorHandler(openFile);
  const revealPreviewSource = useCallback(
    (leafId: string, tab: EditorTab, position: EditorPosition) => {
      const sourceLeafId = layout.revealSource(leafId, tab);
      claimScrollDriver(sourceLeafId);
      setReveal({
        session: tab.session,
        path: tab.path,
        ...(tab.root !== undefined ? { root: tab.root } : {}),
        line: position.line,
        column: position.column,
        nonce: Date.now(),
      });
    },
    [layout, claimScrollDriver],
  );
  const renameFileTab = useCallback(
    async (tab: EditorTab, newName: string): Promise<boolean> => {
      const trimmed = newName.trim();
      if (trimmed === '' || trimmed === basename(tab.path)) return true;
      const nextPath = joinPath(dirOf(tab.path), trimmed);
      try {
        // Load the lazy buffer module BEFORE touching disk. If the editor chunk
        // could not load, the file stays where it is and no dirty model is left
        // stranded under the old path.
        const { rekeyBuffer } = await import('../buffers/buffer-store');
        const result = await renameEntry(tab.session, tab.path, nextPath, tab.root);
        const snapshot = rekeyBuffer(tab.session, tab.path, result.path, tab.root);
        const moveDraft = async () => {
          if (snapshot?.dirty) {
            await saveDraft(
              tab.session,
              result.path,
              snapshot.content,
              snapshot.baseMtimeMs,
              tab.root,
            );
          } else if (!snapshot) {
            // Switching projects may already have released the model and
            // flushed its text to IndexedDB while the rename was pending.
            const draft = await loadDraft(tab.session, tab.path, tab.root);
            if (draft)
              await saveDraft(
                tab.session,
                result.path,
                draft.content,
                draft.base_mtime_ms,
                tab.root,
              );
          }
          await deleteDraft(tab.session, tab.path, tab.root);
        };
        // No mounted model means no old body remains to flush: move its draft
        // before publishing the renamed tab, so a new editor can restore it.
        if (!snapshot) await moveDraft();
        if (profileRef.current === profileId)
          updateWorkspaceTrees(baseUiState, (tree) => renameBufferTabs(tree, tab, result.path));
        void qc.invalidateQueries({ queryKey: ['wt-tree', tab.session] });
        void qc.invalidateQueries({ queryKey: ['wt-git-status', tab.session] });
        // A mounted old body flushes on the layout render. Its rekeyed model
        // already preserves live edits; migrate the browser draft one task later.
        if (snapshot)
          setTimeout(() => {
            void moveDraft().catch(toastError);
          }, 0);
        return true;
      } catch (error) {
        toastError(error);
        return false;
      }
    },
    [qc, baseUiState, profileId],
  );
  return {
    openFile,
    openEditorTab,
    reveal,
    revealPreviewSource,
    revealCompiledSource,
    renameFileTab,
  };
}
