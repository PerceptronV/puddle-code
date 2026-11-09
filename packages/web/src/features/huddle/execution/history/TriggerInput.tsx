import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { HuddleTriggerInputRequest } from '@puddle/shared';
import { huddleTriggerInput } from './api';
import { graphActionClass } from '../../inspector/GraphEditing';

export function TriggerInput({
  profile,
  session,
  request,
}: {
  profile: string;
  session: string;
  request: HuddleTriggerInputRequest;
}) {
  const [open, setOpen] = useState(false);
  const input = useQuery({
    queryKey: ['huddle-trigger-input', profile, session, request],
    queryFn: ({ signal }) => huddleTriggerInput(profile, session, request, signal),
    enabled: open,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const event = input.data?.event;
  const text = event ? JSON.stringify(event.data, null, 2) : '';
  return (
    <div className="space-y-1 text-xs">
      <button
        type="button"
        className={graphActionClass}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Trigger input
      </button>
      {open && (
        <div className="space-y-1" aria-label="Recorded trigger input">
          {input.isPending && <p className="text-fg-muted">Reading recorded input…</p>}
          {input.error && (
            <p role="alert" className="text-fg-muted">
              {input.error.message}
            </p>
          )}
          {input.error && (
            <button
              type="button"
              className={graphActionClass}
              disabled={input.isFetching}
              onClick={() => void input.refetch()}
            >
              Refresh input
            </button>
          )}
          {event && (
            <>
              <p>
                {event.source.node}.{event.port} · {event.source.component}@{event.source.version}
              </p>
              <p className="break-all text-fg-muted">Event {event.id}</p>
              <p className="text-fg-muted">
                Observed {new Date(event.observedAt).toLocaleString()}
              </p>
              {event.occurredAt && (
                <p className="text-fg-muted">
                  Occurred {new Date(event.occurredAt).toLocaleString()}
                </p>
              )}
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
                {text.length > 16384 ? `${text.slice(0, 16384)}\n… Preview truncated` : text}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
