import type { DesktopBufferSnapshot } from '@puddle/shared';
import { LazyEditorTabClose } from '../../editor/lazy-editor-parts';
import { DraftRecovery } from './DraftRecovery';
import { recoveryCloseKey } from './recovery-close';

/** An orphan has no authoritative tab kind: discard only its local recovery copy. */
export function OrphanedDraft({ draft }: { draft: DesktopBufferSnapshot }) {
  return (
    <DraftRecovery
      draft={draft}
      actions={
        <LazyEditorTabClose
          session={draft.session}
          path={draft.path}
          root={draft.root}
          kind="file"
          label={draft.path}
          recovered
          closeKey={recoveryCloseKey(draft)}
          onClose={() => {}}
        />
      }
    />
  );
}
