import type { QueryClient } from '@tanstack/react-query';
import type { FrontendHostUpdateStatus } from '@puddle/shared';

/** Observe the existing update poll, including runtime-only changes without reconnects. */
export function watchInstalledReleases(client: QueryClient, scope: string): () => void {
  const key = ['frontend-host-updates', scope];
  let previous: string | undefined;
  const observe = () => {
    const status = client.getQueryData<FrontendHostUpdateStatus>(key);
    if (status?.availability !== 'ready' || status.observation === 'recorded' || !status.catalogue)
      return;
    const installed = JSON.stringify([
      status.catalogue.daemon_version,
      status.catalogue.runtime_default?.version ?? null,
    ]);
    if (installed === previous) return;
    previous = installed;
    void client.invalidateQueries({ queryKey: ['release-notes'] });
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.type === 'updated' &&
      event.query.queryKey[0] === key[0] &&
      event.query.queryKey[1] === scope
    )
      observe();
  });
  observe();
  return unsubscribe;
}
