import { useQuery } from '@tanstack/react-query';
import type { HuddleCommandTarget } from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../../../../components/ui/dialog';
import { graphActionClass } from '../../inspector/GraphEditing';
import { inspectTriggers } from './api';

const time = (value: string) => new Date(value).toLocaleString();
export function TriggerDialog({
  profile,
  session,
  target,
  stale,
  focused,
  onClose,
}: {
  profile: string;
  session: string;
  target: HuddleCommandTarget;
  stale: boolean;
  focused: boolean;
  onClose(): void;
}) {
  const report = useQuery({
    queryKey: ['huddle-triggers', profile, session, target],
    queryFn: ({ signal }) => inspectTriggers(profile, session, target, signal),
    enabled: focused && !stale,
    retry: false,
    networkMode: 'always',
    gcTime: 0,
    refetchInterval: (query) => (focused && !stale && !query.state.error ? 5000 : false),
    refetchIntervalInBackground: false,
  });
  const data = report.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent wide>
        <DialogTitle>Huddle triggers</DialogTitle>
        <DialogDescription>
          Installed subscriptions and accepted work. Ready means the subscription is installed; it
          does not prove an external service is reachable. Counts describe retained events, not
          unseen work at the source.
        </DialogDescription>
        <div className="flex items-center justify-between gap-3 text-xs text-fg-muted">
          <span>{data ? `Observed ${time(data.observed_at)}` : 'Waiting for observation…'}</span>
          <button
            type="button"
            className={graphActionClass}
            disabled={stale || !focused || report.isFetching}
            onClick={() => void report.refetch()}
          >
            Refresh
          </button>
        </div>
        {stale && (
          <p role="status" className="text-xs text-fg-muted">
            The runtime changed. Close and reopen Triggers to inspect the current activation.
          </p>
        )}
        {report.error && (
          <p role="alert" className="text-xs text-fg-muted">
            {report.error.message}
          </p>
        )}
        {data && (
          <>
            <p className="text-xs">
              {data.backlog.queued} queued · {data.backlog.running} running ·{' '}
              {data.backlog.uncertain_operations} uncertain operations
              {data.queue_limit !== null && (
                <span className="text-fg-muted"> · queue limit {data.queue_limit}</span>
              )}
            </p>
            <p className="text-xs text-fg-muted">
              Backlog includes earlier activations. Source totals below cover this activation only.
            </p>
            <ul
              className="max-h-[55vh] space-y-5 overflow-auto py-2 text-xs"
              aria-label="Trigger health and backlog"
            >
              {data.sources.map((source) => (
                <li key={source.node} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-4">
                    <span>{source.node}</span>
                    <span className="text-fg-muted">{source.health}</span>
                  </div>
                  <p className="text-fg-muted">{source.component}</p>
                  {source.message && <p className="break-words">{source.message}</p>}
                  <p>
                    {source.queued} queued · {source.running} running · {source.admitted} admitted
                  </p>
                  {source.last_event_at && (
                    <p className="text-fg-muted">
                      Last accepted event {time(source.last_event_at)}
                    </p>
                  )}
                  {source.next_at && (
                    <p className="text-fg-muted">Next scheduled {time(source.next_at)}</p>
                  )}
                  {source.missed && (
                    <p className="text-fg-muted">
                      Missed policy: {source.missed} · {source.coalesced} combined occurrences ·{' '}
                      {source.skipped} skipped occurrences
                    </p>
                  )}
                  {source.disposition && (
                    <p className="text-fg-muted">One-off date: {source.disposition}</p>
                  )}
                </li>
              ))}
            </ul>
            {!data.sources.length && (
              <p className="text-xs text-fg-muted">No triggers in this activation.</p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
