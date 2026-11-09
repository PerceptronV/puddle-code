import { Bot } from 'lucide-react';
import { HuddleAction } from '../controls/HuddleAction';
import { useState } from 'react';
import type { Session } from '@puddle/shared';
import { useHuddleSourceDirty } from '../documents/use-source-dirty';
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
      <HuddleAction
        icon={Bot}
        label="Edit with agent"

        disabled={blocked || session.status === 'archived'}
        title={
          blocked ? 'Save or resolve source edits before starting an authoring agent.' : undefined
        }
        onClick={() => setOpen(true)}
      />
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
