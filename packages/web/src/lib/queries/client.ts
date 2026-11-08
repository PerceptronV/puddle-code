import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toastError } from '../transport/errors';

/** Shared by React providers and native commands arriving before their children mount. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
  // Local handlers may add context; toastError collapses duplicate reports.
  mutationCache: new MutationCache({ onError: (error) => toastError(error) }),
});
