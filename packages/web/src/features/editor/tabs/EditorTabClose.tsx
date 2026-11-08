import { useCallback, useSyncExternalStore } from 'react';
import { Circle, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { deleteDraft } from '../../../lib/persistence/drafts';
import { bufferKey, isDirty, subscribe } from '../buffers/buffer-store';
import { announceDraftDiscarded } from '../buffers/editor-sync';
import type { EditorTabKind } from './editor-tabs';
import { useCurrentProfileId } from '../../profile/profile-store';
import { desktopContentState } from '../../windows/state/content-state';
import { desktopWindowContext } from '../../windows/window-context';
import { useEditorCloseRequest } from '../../workspace/tabs/close/TabCloseRequests';
import { cancelDiscardedDraftWrites } from '../buffers/draft-discard';
import { useCloseReview } from '../../workspace/tabs/close/use-close-review';

/** Reactive dirty flag for one (session, path[, root]) buffer. */
function useDirty(session: string, path: string, root?: string): boolean {
  const key = bufferKey(session, path, root);
  const profile = useCurrentProfileId();
  const recovery = profile && desktopWindowContext() ? desktopContentState(profile) : null;
  return useSyncExternalStore(
    useCallback(
      (cb: () => void) => {
        const offModel = subscribe(key, cb);
        const offRecovery = recovery?.subscribe(cb);
        return () => {
          offModel();
          offRecovery?.();
        };
      },
      [key, recovery],
    ),
    () => isDirty(key) || !!recovery?.buffer({ session, path, root }),
  );
}

/**
 * The IN-FLOW dirty marker after a tab chip's filename (SPEC §12): it takes
 * real width — widening the chip up to its cap, the filename truncating past
 * it — instead of sitting over the title. Hidden on hover, where the overlay
 * close × takes its place. Lives behind the lazy editor chunk like the close
 * control below.
 */
export function EditorDirtyDot({
  session,
  path,
  kind,
  root,
}: {
  session: string;
  path: string;
  kind: EditorTabKind;
  /** Absolute browse root of an `external` tab (SPEC §8). */
  root?: string;
}) {
  const dirty = useDirty(session, path, root) && kind !== 'commit';
  if (!dirty) return null;
  return (
    <Circle
      aria-hidden
      className="size-2 shrink-0 fill-current text-fg-muted group-hover:invisible group-focus-visible:invisible group-has-[:focus-visible]:invisible"
    />
  );
}

/**
 * The close control for an editor tab in a tiling pane (SPEC §8): a hover ×
 * (the resting dirty state is `EditorDirtyDot`, in flow after the filename)
 * and a discard-confirm when closing an unsaved file. Lives behind the lazy
 * editor chunk (it reads `buffer-store` → Monaco); the strip renders it under
 * Suspense so a terminal-only workspace never loads Monaco. `commit` tabs are
 * read-only and never dirty.
 */
export function EditorTabClose({
  session,
  path,
  kind,
  root,
  label,
  onClose,
  closeKey,
  recovered = false,
}: {
  session: string;
  path: string;
  kind: EditorTabKind;
  /** Absolute browse root of an `external` tab (SPEC §8). */
  root?: string;
  label: string;
  onClose: (signal?: AbortSignal) => void | Promise<boolean>;
  closeKey?: string;
  recovered?: boolean;
}) {
  const profileId = useCurrentProfileId();
  // Untitled drafts have their own workspace-owned deletion dialogue.
  const dirty = useDirty(session, path, root) && kind !== 'commit' && kind !== 'untitled';
  const { review, pending } = useCloseReview<null>(closeKey ?? bufferKey(session, path, root));

  const requestClose = (signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) return Promise.resolve(false);
    return dirty
      ? review.request('discard', null, signal)
      : Promise.resolve(onClose(signal)).then((accepted) => accepted !== false);
  };
  useEditorCloseRequest(closeKey, requestClose);
  const discard = () => {
    if (!pending || review.get() !== pending) return;
    if (!recovered) cancelDiscardedDraftWrites(session, path, root);
    if (profileId) desktopContentState(profileId).discardBuffer({ session, path, root });
    if (!recovered) {
      void deleteDraft(session, path, root);
      announceDraftDiscarded(session, path, root);
    }
    review.finish(pending, true);
    onClose();
  };

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void requestClose();
        }}
        // Reveal for pointer hover, keyboard focus within the tab, and touch.
        // The floating tray reserves no label width.
        className="flex size-4 items-center justify-center rounded-sm text-fg-muted transition-colors hover:text-fg"
        aria-label={recovered ? `Discard recovered text for ${label}` : `Close ${label}`}
      >
        <X className="size-3" />
      </button>
      <Dialog open={pending !== null} onOpenChange={(open) => !open && review.cancel()}>
        <DialogContent
          // Portals still bubble through React's tab chip. Activating an inactive
          // tab after its discard can persist the old tree and resurrect it.
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>
              {recovered ? `Discard recovered text for ${label}?` : `Discard changes to ${label}?`}
            </DialogTitle>
            <DialogDescription>
              {recovered
                ? 'This removes the recovered copy from this window. Download or copy it first if you want to keep it.'
                : 'This file has unsaved changes. Closing the tab will discard them.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={review.cancel}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={discard}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
