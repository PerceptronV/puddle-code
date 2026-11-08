import { useQuery } from '@tanstack/react-query';
import type { HuddleCommandTarget } from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../../../../components/ui/dialog';
import { reviewHuddleRevision } from './api';
import { RevisionDetails } from './RevisionDetails';

export function RevisionDialog({
  profile,
  session,
  target,
  stale,
  onClose,
}: {
  profile: string;
  session: string;
  target: HuddleCommandTarget;
  stale: boolean;
  onClose(): void;
}) {
  const review = useQuery({
    queryKey: ['huddle-active-revision', profile, session, target],
    queryFn: ({ signal }) => reviewHuddleRevision(profile, session, { target }, signal),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent wide>
        <DialogTitle>Active huddle revision</DialogTitle>
        <DialogDescription>
          Retained source and bindings for this activation. Inspecting does not run code or apply
          saved edits.
        </DialogDescription>
        {stale && (
          <p role="status" className="text-xs text-fg-muted">
            The runtime changed. This view refers to the inspected activation; close and inspect
            again for the current revision.
          </p>
        )}
        {review.isPending && <p className="text-xs text-fg-muted">Loading active revision…</p>}
        {review.error && (
          <p role="alert" className="text-xs text-fg-muted">
            {review.error.message}
          </p>
        )}
        {review.data && (
          <RevisionDetails profile={profile} session={session} review={review.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}
