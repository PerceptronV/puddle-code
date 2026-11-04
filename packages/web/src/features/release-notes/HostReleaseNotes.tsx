import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hostInfoSchema, releaseNotesSchema } from '@puddle/shared';
import { api } from '../../lib/transport/api';
import { browserTransport } from '../../lib/transport/browser-transport';
import { localReleaseHostKey, reportInstalledReleaseNotes } from './state/queue';

/** A shared installed-metadata query. Existing update/reconnect events invalidate this prefix. */
export function HostReleaseNotes({
  hostKey,
  enabled = true,
}: {
  hostKey?: string;
  enabled?: boolean;
}) {
  const host = useQuery({
    queryKey: ['host'],
    queryFn: async ({ signal }) =>
      hostInfoSchema.parse(await api('GET', '/api/host', undefined, signal)),
    staleTime: Infinity,
    enabled: enabled && !hostKey,
    retry: false,
  });
  const key = hostKey ?? (host.data ? localReleaseHostKey(host.data) : undefined);
  const remote = browserTransport();
  const generation = remote?.generation;
  const notes = useQuery({
    queryKey: ['release-notes', key],
    queryFn: async ({ signal }) => {
      const result = releaseNotesSchema.parse(
        await api('GET', '/api/release-notes', undefined, signal),
      );
      if (browserTransport() !== remote || remote?.generation !== generation)
        throw new Error('Release notes connection changed');
      return result;
    },
    enabled: enabled && !!key,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (enabled && key && notes.data && !notes.isError)
      reportInstalledReleaseNotes(key, notes.data);
  }, [enabled, key, notes.data, notes.isError]);
  return null;
}
