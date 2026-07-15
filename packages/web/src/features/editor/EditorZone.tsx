// Load-bearing: import the Monaco bootstrap BEFORE anything that mounts an
// <Editor>. `monaco-setup` runs `loader.config({ monaco })`, which is what
// points @monaco-editor/react at the locally-bundled Monaco instead of
// fetching it from a CDN (hosts may be offline). Keeping this the very first
// import of the lazy editor chunk's entry module guarantees it evaluates
// first (Task 4's handed-off risk). Do not reorder below the others.
import './monaco-setup';

import { useEffect, useRef, useState } from 'react';
import type { Session } from '@puddle/shared';
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
import type { UiStateHandle } from '../workspace/use-ui-state';
import type { RevealTarget } from '../workspace/editor-context';
import { bufferKey, isDirty, releaseModel, retainModel } from './buffer-store';
import { announceDraftDiscarded } from './editor-sync';
import { CodeEditor } from './CodeEditor';
import { EditorTabStrip } from './EditorTabStrip';
import { mediaKind } from './media-kind';
import { MediaViewer } from './MediaViewer';
import {
  activeAfterClose,
  hasTab,
  removeTab,
  sameTab,
  tabKey,
  tabKind,
  type EditorTab,
} from './editor-tabs';
import { DiffTabBody } from '../diff/DiffTabBody';
import { CommitTabBody } from '../history/CommitTabBody';

export interface EditorZoneProps {
  uiState: UiStateHandle;
  sessions: Session[];
  reveal: RevealTarget | null;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * The editor half of the workspace's vertical split (SPEC §8): the tab strip
 * plus the active tab's `CodeEditor`. Only the active tab mounts an editor —
 * restored tabs from the snapshot create their models lazily on first
 * activation, never all at once. Tab open/focus/reorder and `active_editor_tab`
 * live in ui-state; closing a dirty tab confirms first.
 */
export function EditorZone({ uiState, sessions, reveal }: EditorZoneProps) {
  const tabs = uiState.snapshot.editor_tabs;
  const stored = uiState.snapshot.active_editor_tab;
  const activeTab: EditorTab | null =
    stored && hasTab(tabs, stored) ? stored : (tabs[tabs.length - 1] ?? null);

  const [confirm, setConfirm] = useState<EditorTab | null>(null);

  // Restore-on-open: drop tabs whose session is gone or archived (its worktree
  // may not exist), fixing the active tab if it was one of them. Runs once the
  // sessions have loaded.
  const prunedRef = useRef(false);
  // Deliberately narrow deps: the prune is a one-shot restore pass, gated by
  // `prunedRef`, that should run the first time a non-empty `sessions` list
  // arrives. `tabs`/`activeTab`/`uiState` are read from the current render's
  // props — safe because the guard means the body only ever executes on a
  // render where they are fresh — and listing them would only cause extra
  // no-op effect runs after the guard trips (or, without the guard, re-prune
  // on every tab change). `uiState.update` is safe from this closure: it
  // merges into a ref-backed snapshot, not the captured one.
  useEffect(() => {
    if (prunedRef.current || sessions.length === 0) return;
    prunedRef.current = true;
    const alive = new Set(sessions.filter((s) => s.status !== 'archived').map((s) => s.id));
    const kept = tabs.filter((t) => alive.has(t.session));
    if (kept.length !== tabs.length) {
      const nextActive =
        activeTab && alive.has(activeTab.session) ? activeTab : (kept[kept.length - 1] ?? null);
      uiState.update({ editor_tabs: kept, active_editor_tab: nextActive });
    }
  }, [sessions]);

  // Persist the derived active tab so a reload lands on the same one.
  useEffect(() => {
    if (activeTab && (!stored || !sameTab(stored, activeTab))) {
      uiState.update({ active_editor_tab: activeTab });
    } else if (!activeTab && stored) {
      uiState.update({ active_editor_tab: null });
    }
  }, [activeTab, stored]);

  // An open editor tab is one holder of its shared model (SPEC §8): retain
  // while the tab exists, release when it closes. The model outlives tab
  // *switches* (an inactive tab keeps its retain, so its dirty edits survive)
  // and is only disposed once no holder — here or a diff section — remains.
  // Reconciled against the tab list rather than the mounted CodeEditor, which
  // exists only for the active tab. A model created lazily on first activation
  // is retained here from tab-open (retainModel is safe before the model
  // exists); the release then disposes it via the refcount if it was created.
  const heldRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Only file/diff tabs hold the shared buffer; commit tabs are read-only
    // sha→sha with wholly private models (nothing to retain here).
    const want = new Set(
      tabs.filter((t) => tabKind(t) !== 'commit').map((t) => bufferKey(t.session, t.path)),
    );
    const held = heldRef.current;
    for (const key of want) {
      if (!held.has(key)) {
        retainModel(key);
        held.add(key);
      }
    }
    for (const key of [...held]) {
      if (!want.has(key)) {
        releaseModel(key);
        held.delete(key);
      }
    }
  }, [tabs]);
  // The last tab closing unmounts the whole zone before the reconcile above
  // can run for the now-empty list, so release everything still held here.
  useEffect(
    () => () => {
      for (const key of heldRef.current) releaseModel(key);
      heldRef.current.clear();
    },
    [],
  );

  const removeAndDispose = (tab: EditorTab) => {
    // The reconcile effect releases the model once `tab` leaves the list.
    uiState.update({
      editor_tabs: removeTab(tabs, tab),
      active_editor_tab: activeAfterClose(tabs, tab, activeTab),
    });
  };

  const requestClose = (tab: EditorTab) => {
    // Only file/diff tabs can be dirty; a commit tab is read-only, so it never
    // prompts (even if a file tab for the same path happens to be dirty).
    if (tabKind(tab) !== 'commit' && isDirty(bufferKey(tab.session, tab.path))) setConfirm(tab);
    else removeAndDispose(tab);
  };

  const confirmDiscard = () => {
    if (!confirm) return;
    void deleteDraft(confirm.session, confirm.path);
    announceDraftDiscarded(confirm.session, confirm.path);
    removeAndDispose(confirm);
    setConfirm(null);
  };

  return (
    <div className="flex h-full flex-col bg-ground">
      <EditorTabStrip
        tabs={tabs}
        activeTab={activeTab}
        sessions={sessions}
        onActivate={(tab) => uiState.update({ active_editor_tab: tab })}
        onClose={requestClose}
        onReorder={(next) => uiState.update({ editor_tabs: next })}
      />
      <div className="min-h-0 flex-1">
        {/* One body per tab kind (SPEC §8): a plain file editor, a worktree
            diff, or a read-only commit file diff. `tabKey` keys the mount so
            switching kind (or commit) tears the old body down cleanly. */}
        {activeTab && tabKind(activeTab) === 'diff' && (
          <DiffTabBody key={tabKey(activeTab)} session={activeTab.session} path={activeTab.path} />
        )}
        {activeTab && tabKind(activeTab) === 'commit' && activeTab.sha && (
          <CommitTabBody
            key={tabKey(activeTab)}
            session={activeTab.session}
            sha={activeTab.sha}
            path={activeTab.path}
          />
        )}
        {activeTab &&
          tabKind(activeTab) === 'file' &&
          (() => {
            const kind = mediaKind(activeTab.path);
            return kind ? (
              <MediaViewer
                key={tabKey(activeTab)}
                session={activeTab.session}
                path={activeTab.path}
                kind={kind}
              />
            ) : (
              <CodeEditor
                key={tabKey(activeTab)}
                session={activeTab.session}
                path={activeTab.path}
                reveal={reveal}
              />
            );
          })()}
      </div>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes to {confirm ? basename(confirm.path) : ''}?</DialogTitle>
            <DialogDescription>
              This file has unsaved changes. Closing the tab will discard them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={confirmDiscard}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
