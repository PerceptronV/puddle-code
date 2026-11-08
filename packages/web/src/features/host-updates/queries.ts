import { useEffect } from 'react';
import {
  queryOptions,
  useMutation,
  useIsMutating,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  frontendHostUpdateReplySchema,
  frontendHostUpdateStatusSchema,
  versionResponseSchema,
  type FrontendHostUpdateRequest,
  type FrontendHostUpdateStatus,
} from '@puddle/shared';
import { api, ApiError } from '../../lib/transport/api';
import { browserTransport } from '../../lib/transport/browser-transport';
import { wsManager } from '../../lib/transport/ws';
import { hostUpdateScope, hostUpdateTransport } from './transport';
import { watchInstalledReleases } from '../release-notes/state/installed';

function queryKey() {
  return ['frontend-host-updates', hostUpdateScope()] as const;
}

/** Capability comes from the connector's current admitted device, never a browser preference. */
export function useHostUpdateAccess() {
  const remote = browserTransport();
  const access = useQuery({
    queryKey: ['host-update-access', hostUpdateScope(), remote?.generation],
    queryFn: async ({ signal }) => {
      const version = versionResponseSchema.parse(
        await api('GET', '/api/version', undefined, signal),
      );
      return version.protocol.major >= 26 && version.remote_host_updates === true;
    },
    enabled: !!remote,
    staleTime: Infinity,
    retry: false,
  });
  return !remote || access.data === true;
}

export function hostUpdateQuery(allowed = !browserTransport()) {
  const request = hostUpdateTransport(allowed);
  return queryOptions({
    queryKey: queryKey(),
    queryFn: async ({ signal }) => {
      return frontendHostUpdateStatusSchema.parse(await request(undefined, signal));
    },
    enabled: allowed,
    retry: false,
    // A single shared query serves Settings and offers; these are host reads, not GitHub polls.
    staleTime: 5000,
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && query.state.error.status === 404
        ? false
        : ['checking', 'downloading', 'dispatching', 'applying', 'verifying'].includes(
              query.state.data?.result?.operation?.phase ?? '',
            ) || query.state.data?.catalogue?.releases.state === 'checking'
          ? 2000
          : 60_000,
  });
}

export function hostUpdateMutation(client: QueryClient, allowed = !browserTransport()) {
  const key = queryKey();
  const requestUpdate = hostUpdateTransport(allowed);
  return {
    mutationKey: ['frontend-host-update-action', hostUpdateScope()],
    // Never inherit an application's mutation retries or queue writes for later reconnect.
    retry: false as const,
    networkMode: 'always' as const,
    mutationFn: async (request: FrontendHostUpdateRequest) => {
      return frontendHostUpdateReplySchema.parse(await requestUpdate(request));
    },
    onMutate: async () => {
      await client.cancelQueries({ queryKey: key });
    },
    onSuccess: (result: ReturnType<typeof frontendHostUpdateReplySchema.parse>) => {
      client.setQueryData<FrontendHostUpdateStatus>(key, (status) =>
        status ? { ...status, result } : status,
      );
    },
    onSettled: async () => {
      // Even a lost reply may have committed. Only repeat the read.
      await client.invalidateQueries({ queryKey: key });
    },
  };
}

export function useHostUpdates() {
  return useQuery(hostUpdateQuery(useHostUpdateAccess()));
}

export function useHostUpdateAction() {
  const client = useQueryClient();
  const allowed = useHostUpdateAccess();
  const mutationKey = ['frontend-host-update-action', hostUpdateScope()];
  const pending = useIsMutating({ mutationKey });
  // Settings may remount while a request runs. The transport owns its browser/host lifetime.
  const mutation = useMutation(hostUpdateMutation(client, allowed));
  return {
    ...mutation,
    busy: pending > 0,
    act: (request: FrontendHostUpdateRequest) => {
      // Synchronous cache check also catches a double click before React re-renders.
      if (!client.isMutating({ mutationKey })) mutation.mutate(request);
    },
  };
}

/** Mounted once with the window's offer component. Reconnection only refreshes status. */
export function useHostUpdateEvents() {
  const client = useQueryClient();
  const scope = hostUpdateScope();
  useEffect(() => {
    const key = ['frontend-host-updates', scope];
    const refresh = () => {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: ['release-notes'] });
    };
    const changed = wsManager.onHostUpdatesChanged(refresh);
    const installed = watchInstalledReleases(client, scope);
    const connected = wsManager.onConnectionChange((ready) => {
      if (ready) refresh();
    });
    return () => {
      changed();
      installed();
      connected();
    };
  }, [client, scope]);
}
