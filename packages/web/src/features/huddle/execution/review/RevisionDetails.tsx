import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HuddleRetainedRevision, HuddleReview, HuddleReviewEntry } from '@puddle/shared';
import { ReadOnlyDiff } from '../../../diff/ReadOnlyDiff';
import { ReadOnlyView } from '../../../diff/FileDiffContent';
import { graphActionClass } from '../../inspector/GraphEditing';
import { reviewRetainedHuddleRevision, reviewHuddleRevision } from './api';

export function RevisionDetails({
  profile,
  session,
  review,
}: {
  profile: string;
  session: string;
  review: HuddleReview | HuddleRetainedRevision;
}) {
  const instance = useId();
  const recorded = 'source' in review;
  const revision = recorded ? review.revision : review.active.revision;
  const activation = recorded ? review.activation : review.active;
  const [selected, select] = useState<HuddleReviewEntry | null>(
    () =>
      (
        review.entries.find((item) => !['retained', 'unchanged'].includes(item.change)) ??
        review.entries[0]
      )?.entry ?? null,
  );
  const [all, showAll] = useState(!review.saved);
  const content = useQuery<HuddleReview | HuddleRetainedRevision>({
    queryKey: [
      'huddle-revision-content',
      profile,
      session,
      recorded ? ['retained', review.owner, revision] : review.target,
      review.saved?.digest,
      selected,
    ],
    queryFn: ({ signal }) =>
      recorded
        ? reviewRetainedHuddleRevision(
            profile,
            session,
            {
              owner: review.owner,
              revision,
              entry: selected!,
              ...(review.saved ? { expected_digest: review.saved.digest } : {}),
            },
            signal,
          )
        : reviewHuddleRevision(
            profile,
            session,
            {
              target: review.target,
              entry: selected!,
              ...(review.saved ? { expected_digest: review.saved.digest } : {}),
            },
            signal,
          ),
    enabled: selected !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const changes = review.entries.filter((item) => !['unchanged', 'retained'].includes(item.change));
  const entries = all ? review.entries : changes;
  const text = content.data?.content;
  const path = selected?.kind === 'component' ? `${selected.path}.json` : (selected?.path ?? '');
  return (
    <div className="min-w-0 space-y-3" aria-label="Revision review">
      <div className="space-y-1 text-xs text-fg-muted">
        <p className="break-all">
          {recorded ? 'Recorded revision' : 'Active revision'} {revision}
        </p>
        {review.saved && <p className="break-all">Saved revision {review.saved.digest}</p>}
        <p>
          {review.saved
            ? `${changes.length} changed ${changes.length === 1 ? 'entry' : 'entries'}`
            : `${entries.length} retained entries`}
        </p>
        {activation && (
          <details>
            <summary className="cursor-pointer hover:text-fg">
              {recorded ? 'Recorded' : 'Active'} variables and resolved bindings
            </summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words p-2">
              {JSON.stringify(
                {
                  worktree: activation.worktree,
                  appliedAt: new Date(activation.appliedAt).toLocaleString(),
                  variables: activation.variables,
                  bindings: activation.bindings,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
        {review.saved?.diagnostics.map((note, index) => (
          <p key={index}>
            {note.severity}: {note.message}
          </p>
        ))}
      </div>
      {review.saved && (
        <button
          type="button"
          className={graphActionClass}
          aria-pressed={all}
          onClick={() => showAll(!all)}
        >
          {all ? 'Show changes only' : 'Show all entries'}
        </button>
      )}
      <div className="max-h-32 overflow-auto" aria-label="Revision entries">
        {entries.map((item) => (
          <button
            type="button"
            key={`${item.entry.kind}:${item.entry.path}`}
            className={`${graphActionClass} flex w-full items-center justify-between gap-3 text-left aria-pressed:bg-explorer-selection`}
            aria-pressed={selected?.kind === item.entry.kind && selected.path === item.entry.path}
            onClick={() => select(item.entry)}
          >
            <span className="min-w-0 truncate">
              {item.entry.kind === 'component' ? 'Contract · ' : ''}
              {item.entry.path}
            </span>
            <span className="shrink-0 text-fg-muted">{item.change}</span>
          </button>
        ))}
      </div>
      {content.error && (
        <p role="alert" className="text-xs text-fg-muted">
          {content.error.message} Close and inspect again to review current source.
        </p>
      )}
      {content.isFetching && <p className="text-xs text-fg-muted">Loading retained source…</p>}
      {text && (
        <>
          <p className="break-all text-xs text-fg-muted">
            {selected?.path} ·{' '}
            {review.saved
              ? `${recorded ? 'Retained' : 'Active'} on the left · Saved on the right`
              : 'Retained source'}
            {review.saved &&
              (text.before === null ? ' · Added' : text.after === null ? ' · Removed' : '')}
          </p>
          <div className="h-72 min-w-0" aria-label="Revision source">
            {review.saved ? (
              <ReadOnlyDiff
                key={`${selected?.kind}:${path}`}
                session={session}
                originalRef={`huddle:${revision}`}
                originalPath={path}
                originalContent={text.before ?? ''}
                modifiedRef={`huddle:${review.saved.digest}`}
                modifiedPath={path}
                modifiedContent={text.after ?? ''}
              />
            ) : (
              <ReadOnlyView
                key={`${selected?.kind}:${path}`}
                session={`${session}:${instance}`}
                refName={`huddle:${revision}`}
                path={path}
                content={text.before ?? ''}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
