import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  huddleAvailabilitySchema,
  huddleDiscoverySchema,
  huddleDocumentSchema,
  huddleOpenedSchema,
  supportsApplicationFeature,
  type HuddleCreate,
  type HuddleDuplicate,
  type HuddleOpen,
  type Session,
} from '@puddle/shared';
import { api } from '../../../lib/transport/api';
import { browserTransport } from '../../../lib/transport/browser-transport';
import { desktopBridge } from '../../../lib/desktop';
import { useDaemonVersion } from '../../../lib/queries/queries';

export function huddleShellSupported(): boolean {
  const bridge = desktopBridge();
  return !bridge || bridge.windows?.huddles === true;
}
export function useHuddleSupported() {
  const protocol = useDaemonVersion().data?.protocol;
  return (
    !browserTransport() &&
    huddleShellSupported() &&
    supportsApplicationFeature(protocol, { major: 28, minor: 0 })
  );
}
export function useHuddleAvailability(profile: string | undefined, enabled: boolean) {
  const supported = useHuddleSupported();
  return useQuery({
    queryKey: ['huddle-availability', profile],
    queryFn: async ({ signal }) =>
      huddleAvailabilitySchema.parse(
        await api('GET', `/api/huddle/${profile}/availability`, undefined, signal),
      ),
    enabled: enabled && supported && !!profile,
    retry: false,
  });
}
export function useHuddleDefinitions(
  profile: string | undefined,
  project: string,
  worktree: string,
  enabled: boolean,
) {
  const supported = useHuddleSupported();
  return useQuery({
    queryKey: ['huddle-definitions', profile, project, worktree],
    queryFn: async ({ signal }) =>
      huddleDiscoverySchema.parse(
        await api(
          'GET',
          `/api/huddle/${profile}/definitions?${new URLSearchParams({ project_id: project, worktree })}`,
          undefined,
          signal,
        ),
      ),
    enabled: enabled && supported && !!profile && !!worktree,
    retry: false,
  });
}
export function useHuddleDocument(profile: string | undefined, session: Session) {
  const supported = useHuddleSupported();
  return useQuery({
    queryKey: [
      'huddle-document',
      profile,
      session.project_id,
      session.worktree_path,
      session.huddle_id,
    ],
    queryFn: async ({ signal }) =>
      huddleDocumentSchema.parse(
        await api(
          'GET',
          `/api/huddle/${profile}/definitions/${session.huddle_id}?${new URLSearchParams({ project_id: session.project_id, worktree: session.worktree_path })}`,
          undefined,
          signal,
        ),
      ),
    enabled: supported && !!profile && !!session.huddle_id,
    retry: false,
  });
}
export function useHuddleOpen(profile: string | undefined) {
  const cache = useQueryClient();
  const protocol = useDaemonVersion().data?.protocol;
  return useMutation({
    mutationFn: async (
      input:
        | { kind: 'create'; value: HuddleCreate }
        | { kind: 'open'; value: HuddleOpen }
        | { kind: 'duplicate'; value: HuddleDuplicate },
    ) => {
      if (!profile || browserTransport() || !huddleShellSupported())
        throw new Error('Huddle authoring is unavailable on this connection');
      if (
        input.kind === 'duplicate' &&
        !supportsApplicationFeature(protocol, { major: 28, minor: 26 })
      )
        throw new Error('Copying a huddle requires a supporting host');
      const path =
        input.kind === 'duplicate'
          ? `definitions/${input.value.huddle_id}/duplicate`
          : input.kind === 'create'
            ? 'definitions'
            : 'open';
      const body =
        input.kind === 'duplicate'
          ? {
              project_id: input.value.project_id,
              worktree: input.value.worktree,
              name: input.value.name,
              expected_digest: input.value.expected_digest,
            }
          : input.value;
      return huddleOpenedSchema.parse(await api('POST', `/api/huddle/${profile}/${path}`, body));
    },
    retry: false,
    onSuccess: ({ session }) => {
      cache.setQueryData(['session', session.id], session);
      void cache.invalidateQueries({ queryKey: ['sessions'] });
      void cache.invalidateQueries({ queryKey: ['project', session.project_id] });
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ['huddle-definitions'] });
    },
  });
}
