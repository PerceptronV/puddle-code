import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HuddleHistoryOwnersRequest, HuddleRetainedHistoryRequest } from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../../../../components/ui/dialog';
import { ControlTray } from '../../../../components/ui/control-tray';
import { graphActionClass } from '../../inspector/GraphEditing';
import { HistoryDialog } from '../HistoryDialog';
import { huddleHistoryOwners } from './api';

export function RecordedHistoryDialog({
  profile,
  session,
  onClose,
}: {
  profile: string;
  session: string;
  onClose(): void;
}) {
  const [cursors, setCursors] = useState<Array<HuddleHistoryOwnersRequest['after']>>([undefined]);
  const [owner, setOwner] = useState<HuddleRetainedHistoryRequest['owner'] | null>(null);
  const after = cursors.at(-1);
  const owners = useQuery({
    queryKey: ['huddle-history-owners', profile, session, after],
    queryFn: ({ signal }) => huddleHistoryOwners(profile, session, { after }, signal),
    enabled: !owner,
    retry: false,
    networkMode: 'always',
    refetchOnWindowFocus: false,
  });
  if (owner)
    return (
      <HistoryDialog
        key={`${owner.runtimeId}:${owner.incarnation}`}
        profile={profile}
        session={session}
        owner={owner}
        retained
        onRecordedRuntimes={() => setOwner(null)}
        onClose={onClose}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Recorded huddle runtimes</DialogTitle>
        <DialogDescription>
          Choose a retained runtime to inspect its ledger. Recorded states do not prove that a
          runtime is connected or stopped.
        </DialogDescription>
        <ControlTray label="Recorded runtime pages" className="w-fit">
          <button
            type="button"
            className={graphActionClass}
            disabled={owners.isFetching}
            onClick={() => void owners.refetch()}
          >
            Refresh runtimes
          </button>
          <button
            type="button"
            className={graphActionClass}
            disabled={owners.isFetching || cursors.length === 1}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Previous runtimes
          </button>
          <button
            type="button"
            className={graphActionClass}
            disabled={owners.isFetching || !owners.data?.next}
            onClick={() => setCursors([...cursors, owners.data!.next!])}
          >
            Older runtimes
          </button>
        </ControlTray>
        {owners.error && (
          <p role="alert" className="text-xs text-fg-muted">
            {owners.error.message}
          </p>
        )}
        {owners.isPending && <p className="text-xs text-fg-muted">Loading recorded runtimes…</p>}
        {owners.data?.records.length === 0 && (
          <p className="text-xs text-fg-muted">No recorded runtimes on this page.</p>
        )}
        <div className="max-h-80 space-y-1 overflow-auto" aria-label="Recorded runtimes">
          {owners.data?.records.map((record) => (
            <button
              key={record.owner.runtimeId}
              type="button"
              className={`${graphActionClass} flex w-full flex-col items-start text-left`}
              onClick={() => setOwner(record.owner)}
            >
              <span>
                {new Date(record.created_at).toLocaleString()} · {record.recorded_state}
              </span>
              <span className="break-all text-fg-muted">
                {record.owner.runtimeId} · {record.build}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
