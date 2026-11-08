import type { HuddleRuntimeInspection } from '@puddle/shared';

type Sources = NonNullable<
  Extract<NonNullable<HuddleRuntimeInspection['owner']>, { connected: true }>['custom_triggers']
>;
export function TriggerHealth({ sources }: { sources: Sources }) {
  if (!sources.length) return null;
  return (
    <details
      className="px-4 pb-2 text-xs"
      open={sources.some((source) => source.health.state === 'gap')}
    >
      <summary className="cursor-pointer py-1 text-fg-muted">
        Custom triggers · {sources.filter((source) => source.health.state === 'ready').length} ready
      </summary>
      <ul className="space-y-1 py-1" aria-label="Custom trigger health">
        {sources.map((source) => (
          <li key={source.node}>
            <span>
              {source.node} · {source.health.state}
            </span>
            {'message' in source.health && (
              <span className="text-fg-muted"> · {source.health.message}</span>
            )}
          </li>
        ))}
      </ul>
      {sources.some((source) => source.health.state === 'gap') && (
        <p className="py-1 text-fg-muted">
          Inspect the source, then interrupt and resume to reopen its subscription. Other sources
          may still be running.
        </p>
      )}
    </details>
  );
}
