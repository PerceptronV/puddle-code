import { useQuery } from '@tanstack/react-query';
import type { HuddleRetainedRevisionRequest } from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../../../../components/ui/dialog';
import { graphActionClass } from '../../inspector/GraphEditing';
import { reviewRetainedHuddleRevision } from './api';
import { RevisionDetails } from './RevisionDetails';

export function RetainedRevisionDialog({
  profile,
  session,
  request,
  onBack,
  onClose,
}: {
  profile: string;
  session: string;
  request: HuddleRetainedRevisionRequest;
  onBack(): void;
  onClose(): void;
}) {
  const review = useQuery({
    queryKey: ['huddle-retained-revision', profile, session, request],
    queryFn: ({ signal }) => reviewRetainedHuddleRevision(profile, session, request, signal),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent wide>
        <DialogTitle>Recorded huddle revision</DialogTitle>
        <DialogDescription>
          Retained source from this runtime. Recorded settings describe the last saved activation;
          they do not establish current activity.
        </DialogDescription>
        <button type="button" className={`${graphActionClass} w-fit`} onClick={onBack}>
          Back to history
        </button>
        <p className="break-all text-xs text-fg-muted">Runtime {request.owner.runtimeId}</p>
        {review.isPending && <p className="text-xs text-fg-muted">Loading recorded revision…</p>}
        {review.error && (
          <p role="alert" className="text-xs text-fg-muted">
            {review.error.message}
          </p>
        )}
        {review.data && (
          <>
            <p className="text-xs text-fg-muted">
              Read {new Date(review.data.observed_at).toLocaleString()}
            </p>
            <RevisionDetails profile={profile} session={session} review={review.data} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
