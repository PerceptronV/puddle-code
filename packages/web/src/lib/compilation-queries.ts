import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  CompilationCapabilitiesResponse,
  CompilationModeRequest,
  CompilationRunRequest,
  CompilationRunResponse,
  CompilationStatusResponse,
  CompilationTargetRequest,
} from '@puddle/shared';
import { api } from './api';

/** Providers available on the machine running puddled (which may be an SSH host). */
export function useCompilationCapabilities(enabled: boolean) {
  return useQuery({
    queryKey: ['compilation-capabilities'],
    queryFn: () => api<CompilationCapabilitiesResponse>('GET', '/api/compilation/capabilities'),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** One explicit provider run. */
export function useRunCompilation() {
  return useMutation({
    mutationFn: (request: CompilationRunRequest) =>
      api<CompilationRunResponse>('POST', '/api/compilation/run', request),
  });
}

/** Select on-demand or daemon-observed eager operation for a source. */
export function setCompilationMode(request: CompilationModeRequest) {
  return api<CompilationStatusResponse>('PUT', '/api/compilation/mode', request);
}

/** Poll one eager source without encoding absolute roots into a query string. */
export function compilationStatus(request: CompilationTargetRequest) {
  return api<CompilationStatusResponse>('POST', '/api/compilation/status', request);
}

/** Live status of one registered eager source. */
export function useCompilationStatus(request: CompilationTargetRequest, enabled: boolean) {
  return useQuery({
    queryKey: ['compilation-status', request.provider, request.source],
    queryFn: () => compilationStatus(request),
    enabled,
    refetchInterval: 750,
    refetchIntervalInBackground: false,
    retry: 2,
  });
}
