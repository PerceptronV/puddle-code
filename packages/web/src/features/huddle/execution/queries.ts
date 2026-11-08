import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supportsApplicationFeature } from '@puddle/shared';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { useHuddleSupported } from '../documents/queries';
import { inspectHuddle, sendHuddleCommand, type HuddleCommand } from './api';

export const runtimeKey = (profile: string, session: string) =>
  ['huddle-runtime', profile, session] as const;
export const historyKey = (profile: string, session: string) =>
  ['huddle-history', profile, session] as const;
export function useHuddleExecutionSupported() {
  const supported = useHuddleSupported();
  const protocol = useDaemonVersion().data?.protocol;
  return supported && supportsApplicationFeature(protocol, { major: 28, minor: 2 });
}
export function useHuddleRuntime(profile: string, session: string, focused: boolean) {
  const supported = useHuddleExecutionSupported();
  return useQuery({
    queryKey: runtimeKey(profile, session),
    queryFn: ({ signal }) => inspectHuddle(profile, session, signal),
    enabled: supported && !!profile && focused,
    retry: false,
    networkMode: 'always',
    staleTime: 0,
    refetchInterval: (query) => (focused && !query.state.error ? 3000 : false),
    refetchIntervalInBackground: false,
  });
}
interface CommandStatus {
  pending: boolean;
  review: boolean;
  error: string | null;
  executionId: string | null;
}
const initial: CommandStatus = { pending: false, review: false, error: null, executionId: null };

/** Shared per placement in this renderer; unmount/reconnect never queues or retries a mutation. */
export function useHuddleCommands(profile: string, session: string) {
  const supported = useHuddleExecutionSupported();
  const cache = useQueryClient();
  const key = ['huddle-command', profile, session];
  const status = useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data;
  const mutation = useMutation({
    mutationKey: key,
    retry: false,
    networkMode: 'always',
    mutationFn: (command: HuddleCommand) => sendHuddleCommand(profile, session, command),
    onSuccess: (reply) => {
      if (reply.action === 'state') cache.setQueryData(runtimeKey(profile, session), reply.value);
      cache.setQueryData<CommandStatus>(key, {
        ...initial,
        executionId: reply.action === 'run' ? reply.value.executionId : null,
      });
    },
    onError: (error) =>
      cache.setQueryData<CommandStatus>(key, { ...initial, review: true, error: error.message }),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: runtimeKey(profile, session) });
      void cache.invalidateQueries({ queryKey: historyKey(profile, session) });
      void cache.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  return {
    status,
    async send(command: HuddleCommand) {
      const current = cache.getQueryData<CommandStatus>(key) ?? initial;
      if (!supported || !profile) throw new Error('This host does not support huddle execution');
      if (current.pending || current.review || cache.isMutating({ mutationKey: key }))
        throw new Error('Inspect the previous command before another action');
      cache.setQueryData<CommandStatus>(key, { ...initial, pending: true });
      return mutation.mutateAsync(command);
    },
    reviewed() {
      const current = cache.getQueryData<CommandStatus>(key) ?? initial;
      if (!current.pending)
        cache.setQueryData<CommandStatus>(key, { ...current, review: false, error: null });
    },
  };
}
