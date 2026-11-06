import type { QueryClient } from '@tanstack/react-query';
import type {
  CompilationFileTarget,
  NotebookExecutionResponse,
  NotebookObservationResponse,
} from '@puddle/shared';
import { api } from '../../../lib/transport/api';
import { focusAwareInterval } from '../../../lib/queries/poll-focus';

const activeInterval = focusAwareInterval(250);
const idleInterval = focusAwareInterval(5000);
export const notebookObservationInterval = (data?: NotebookExecutionResponse): number =>
  data?.execution?.state === 'running' ? activeInterval() : idleInterval();

/** Cached full snapshots stay in Query; only matching subsequent observations opt in. */
export function notebookObservation(
  client: QueryClient,
  source: CompilationFileTarget,
  revisions: boolean,
) {
  const queryKey = ['notebook-execution', source] as const;
  let fresh = true;
  return {
    queryKey,
    reset: () => {
      fresh = true;
    },
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<NotebookExecutionResponse> => {
      const state = client.getQueryState<NotebookExecutionResponse>(queryKey);
      const previous =
        !fresh && !state?.isInvalidated && state?.status !== 'error' ? state?.data : undefined;
      const known = previous?.execution
        ? { id: previous.execution.id, revision: previous.execution.revision }
        : null;
      try {
        const response = await api<NotebookObservationResponse>(
          'POST',
          '/api/notebooks/execution',
          {
            source,
            ...(revisions && previous ? { known } : {}),
          },
          signal,
        );
        signal.throwIfAborted();
        if ('unchanged' in response) {
          if (!previous) throw new Error('Notebook observation has no matching snapshot');
          fresh = false;
          // A successful explicit run may already have refreshed the shared cache.
          return client.getQueryData<NotebookExecutionResponse>(queryKey) ?? previous;
        }
        fresh = false;
        return response;
      } catch (error) {
        fresh = true;
        throw error;
      }
    },
  };
}
