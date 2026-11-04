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
  cockpitHostUpdateReplySchema,
  cockpitHostUpdateStatusSchema,
  type CockpitHostUpdateRequest,
  type CockpitHostUpdateStatus,
} from '@puddle/shared';
import { api, ApiError } from '../../lib/transport/api';
import { browserTransport } from '../../lib/transport/browser-transport';
import { wsManager } from '../../lib/transport/ws';

const key = ['cockpit-host-updates'] as const;
const mutationKey = ['cockpit-host-update-action'] as const;

function requireLocalCockpit() {
  if (browserTransport()) throw new Error('Host updates require a local or SSH cockpit.');
}

export function hostUpdateQuery() {
  return queryOptions({
    queryKey: key,
    queryFn: async () => {
      requireLocalCockpit();
      return cockpitHostUpdateStatusSchema.parse(await api('GET', '/cockpit/updates'));
    },
    enabled: !browserTransport(),
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

export function hostUpdateMutation(client: QueryClient) {
  return {
    mutationKey,
    // Never inherit an application's mutation retries or queue writes for later reconnect.
    retry: false as const,
    networkMode: 'always' as const,
    mutationFn: async (request: CockpitHostUpdateRequest) => {
      requireLocalCockpit();
      return cockpitHostUpdateReplySchema.parse(await api('POST', '/cockpit/updates', request));
    },
    onMutate: async () => {
      await client.cancelQueries({ queryKey: key });
    },
    onSuccess: (result: ReturnType<typeof cockpitHostUpdateReplySchema.parse>) => {
      client.setQueryData<CockpitHostUpdateStatus>(key, (status) =>
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
  return useQuery(hostUpdateQuery());
}

export function useHostUpdateAction() {
  const client = useQueryClient();
  const pending = useIsMutating({ mutationKey });
  const mutation = useMutation(hostUpdateMutation(client));
  return {
    ...mutation,
    busy: pending > 0,
    act: (request: CockpitHostUpdateRequest) => {
      // Synchronous cache check also catches a double click before React re-renders.
      if (!client.isMutating({ mutationKey })) mutation.mutate(request);
    },
  };
}

/** Mounted once with the window's offer component. Reconnection only refreshes status. */
export function useHostUpdateEvents() {
  const client = useQueryClient();
  useEffect(() => {
    if (browserTransport()) return;
    const refresh = () => {
      void client.invalidateQueries({ queryKey: key });
    };
    const changed = wsManager.onHostUpdatesChanged(refresh);
    const connected = wsManager.onConnectionChange((ready) => {
      if (ready) refresh();
    });
    return () => {
      changed();
      connected();
    };
  }, [client]);
}
