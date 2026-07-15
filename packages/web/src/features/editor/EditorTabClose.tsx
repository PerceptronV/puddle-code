import { useCallback, useState, useSyncExternalStore } from 'react';
import { Circle, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { deleteDraft } from '../../lib/drafts';
import { bufferKey, isDirty, subscribe } from './buffer-store';
import { announceDraftDiscarded } from './editor-sync';
import type { EditorTabKind } from './editor-tabs';

/** Reactive dirty flag for one (session, path) buffer. */
function useDirty(session: string, path: string): boolean {
  const key = bufferKey(session, path);
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(key, cb), [key]),
    () => isDirty(key),
  );
}

/**
 * The close control for an editor tab in a tiling pane (SPEC §8): a dirty dot
 * that becomes a close × on hover, and a discard-confirm when closing an unsaved
 * file. Lives behind the lazy editor chunk (it reads `buffer-store` → Monaco);
 * the strip renders it under Suspense so a terminal-only workspace never loads
 * Monaco. `commit` tabs are read-only and never dirty.
 */
export function EditorTabClose({
  session,
  path,
  kind,
  label,
  onClose,
}: {
  session: string;
  path: string;
  kind: EditorTabKind;
  label: string;
  onClose: () => void;
}) {
  const dirty = useDirty(session, path) && kind !== 'commit';
  const [confirm, setConfirm] = useState(false);

  const requestClose = () => (dirty ? setConfirm(true) : onClose());
  const discard = () => {
    void deleteDraft(session, path);
    announceDraftDiscarded(session, path);
    setConfirm(false);
    onClose();
  };

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          requestClose();
        }}
        className="flex size-4 items-center justify-center rounded-sm text-fg-muted transition-colors hover:text-fg"
        aria-label={`Close ${label}`}
      >
        {dirty ? (
          <>
            <Circle className="size-2 fill-current group-hover:hidden" />
            <X className="hidden size-3 group-hover:block" />
          </>
        ) : (
          <X className="size-3 opacity-0 group-hover:opacity-100" />
        )}
      </button>
      <Dialog open={confirm} onOpenChange={(open) => !open && setConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes to {label}?</DialogTitle>
            <DialogDescription>
              This file has unsaved changes. Closing the tab will discard them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
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
