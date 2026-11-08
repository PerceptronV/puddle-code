import { useState } from 'react';
import type { Session } from '@puddle/shared';
import { useHuddleSourceDirty } from '../documents/use-source-dirty';
import { graphActionClass } from '../inspector/GraphEditing';
import { AuthoringDialog } from './AuthoringDialog';

export function AuthoringAction({
  profile,
  session,
  locked,
}: {
  profile: string;
  session: Session;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const dirty = useHuddleSourceDirty(session);
  const blocked = locked || dirty;
  return (
    <>
      <button
        type="button"
        className={graphActionClass}
        disabled={blocked || session.status === 'archived'}
        title={
          blocked ? 'Save or resolve source edits before starting an authoring agent.' : undefined
        }
        onClick={() => setOpen(true)}
      >
        Edit with agent
      </button>
      {open && (
        <AuthoringDialog
          profile={profile}
          session={session}
          blocked={blocked || session.status === 'archived'}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
