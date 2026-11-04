import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';
import { releaseNotesQueue } from './state/queue';

const ReleaseNotesDialog = lazy(() =>
  import('./presentation/ReleaseNotesDialog').then((module) => ({
    default: module.ReleaseNotesDialog,
  })),
);

/** Mount once per application shell; all connected hosts feed this single presentation queue. */
export function ReleaseNotesHost({ remote = false }: { remote?: boolean }) {
  const groups = useSyncExternalStore(releaseNotesQueue.subscribe, releaseNotesQueue.snapshot);
  const current = groups[0];
  useEffect(() => {
    if (!__PUDDLE_RELEASE_NOTES__) return;
    const components = remote ? (['cockpit', 'remote'] as const) : (['cockpit'] as const);
    releaseNotesQueue.enqueue(
      'browser',
      components.map((component) => ({
        component,
        version: __PUDDLE_RELEASE_VERSION__,
        markdown: __PUDDLE_RELEASE_NOTES__!,
      })),
    );
  }, [remote]);
  return current ? (
    <Suspense fallback={null}>
      <ReleaseNotesDialog current={current} />
    </Suspense>
  ) : null;
}
