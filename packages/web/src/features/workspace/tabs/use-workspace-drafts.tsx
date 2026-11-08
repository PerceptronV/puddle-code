import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UNTITLED_SESSION, type Session, type TabRef } from '@puddle/shared';
import { toast } from 'sonner';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { createUntitled, deleteUntitled } from '../../../lib/queries/untitled-queries';
import { untitledSupported } from '../../../lib/transport/protocol-support';
import { toastError } from '../../../lib/transport/errors';
import { useHotkeyLabel } from '../../../lib/navigation/hotkeys';
import {
  forgetUntitledContent,
  setUntitledSaveHandler,
  type UntitledSaveRequest,
} from '../../editor/buffers/untitled-save-store';
import type { EditorTab } from '../../editor/tabs/editor-tabs';
import { useCurrentProfileId } from '../../profile/profile-store';
import type { UiStateHandle } from '../use-ui-state';
import { updateWorkspaceTrees } from '../layout/update-workspace-trees';
import { replaceUntitled, discardUntitled } from './untitled-layout';
import { UntitledSaveDialog } from './UntitledSaveDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { desktopContentState } from '../../windows/state/content-state';
import { useCloseReview } from './close/use-close-review';
import { settleUntitledWriters } from '../../editor/buffers/untitled-writers';

/** Own draft creation, save destination and discard confirmation independently of the shell. */
export function useWorkspaceDrafts({
  baseUiState,
  scopeKey,
  projectId,
  targetSession,
  targetRoot,
  openEditorTab,
}: {
  baseUiState: UiStateHandle;
  scopeKey: string;
  projectId: string;
  targetSession: Session | null;
  targetRoot?: string;
  openEditorTab: (tab: EditorTab) => void;
}) {
  const profileId = useCurrentProfileId();
  const protocol = useDaemonVersion().data?.protocol;
  const qc = useQueryClient();
  const saveKey = useHotkeyLabel('editor.save');
  const identity = `${profileId}:${projectId}:${scopeKey}`;
  const epoch = useRef({ identity, token: {} });
  if (epoch.current.identity !== identity) epoch.current = { identity, token: {} };
  const profileRef = useRef(profileId);
  profileRef.current = profileId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const create = useCallback(async () => {
    if (profileId === null) return;
    if (!untitledSupported(protocol)) {
      toast.error('Untitled drafts need a newer daemon — refresh the connection to update it');
      return;
    }
    const token = epoch.current.token;
    try {
      const { name } = await createUntitled(profileId);
      if (!mounted.current || epoch.current.token !== token) {
        // No tab was ever opened; do not leave an unreachable empty draft.
        await deleteUntitled(profileId, name);
        return;
      }
      openEditorTab({ kind: 'untitled', session: UNTITLED_SESSION, path: name });
    } catch (error) {
      toastError(error);
    }
  }, [profileId, protocol, openEditorTab]);

  // Freeze the destination at invocation. Navigation while the dialogue is
  // open must not silently redirect its write to another project's worktree.
  const [saving, setSaving] = useState<{
    request: UntitledSaveRequest;
    session: Session | null;
    root?: string;
    profileId: string | null;
  } | null>(null);
  useEffect(() => {
    setUntitledSaveHandler((request) =>
      setSaving({ request, session: targetSession, root: targetRoot, profileId }),
    );
    return () => setUntitledSaveHandler(null);
  }, [targetSession, targetRoot, profileId]);
  const { review, pending: discarding } = useCloseReview<{ name: string; profileId: string }>(
    identity,
  );
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const requestDiscard = useCallback(
    (_leafId: string, ref: TabRef, signal?: AbortSignal) => {
      if (ref.type !== 'editor' || !profileId || deletingRef.current) return Promise.resolve(false);
      return review.request(ref.tab.path, { name: ref.tab.path, profileId }, signal);
    },
    [profileId, review],
  );
  const discard = async () => {
    const pending = discarding;
    if (!pending || review.get() !== pending || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const { profileId: draftProfile, name } = pending.value;
    try {
      await settleUntitledWriters(draftProfile, name);
      if (!mounted.current || review.get() !== pending || profileRef.current !== draftProfile)
        return;
      await deleteUntitled(draftProfile, name);
      // Quit/navigation can cancel the review while the approved host deletion
      // is in flight. Keep the local recovery text until a fresh explicit review.
      if (!mounted.current || review.get() !== pending || profileRef.current !== draftProfile)
        return;
      desktopContentState(draftProfile).discardBuffer({
        session: UNTITLED_SESSION,
        path: name,
      });
      forgetUntitledContent(name);
      review.finish(pending, true);
      updateWorkspaceTrees(baseUiState, (tree) => discardUntitled(tree, name));
    } catch (error) {
      toastError(error);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };
  const dialogs = (
    <>
      <UntitledSaveDialog
        request={saving?.request ?? null}
        targetSession={saving?.session ?? null}
        targetRoot={saving?.root}
        targetLabel={saving?.root ?? saving?.session?.branch ?? ''}
        profileId={saving?.profileId ?? undefined}
        onClose={() => setSaving(null)}
        onSaved={(name, session, path, root) => {
          const saved = saving;
          setSaving((current) => (current === saved ? null : current));
          void qc.invalidateQueries({ queryKey: ['wt-tree', session] });
          if (!mounted.current || profileRef.current !== saved?.profileId) return;
          const tab: EditorTab =
            root === undefined
              ? { kind: 'file', session, path }
              : { kind: 'external', session, path, root };
          updateWorkspaceTrees(baseUiState, (tree) => replaceUntitled(tree, name, tab));
        }}
      />
      <Dialog open={discarding !== null} onOpenChange={(open) => !open && review.cancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard this draft?</DialogTitle>
            <DialogDescription>
              Closing {discarding?.value.name} deletes its draft — {saveKey} saves it into the
              worktree instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={review.cancel} disabled={deleting}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => void discard()} disabled={deleting}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return { create, requestDiscard, dialogs };
}
