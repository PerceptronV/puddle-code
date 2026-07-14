import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Account,
  AgentType,
  CreateSessionRequest,
  DaemonConfig,
  DaemonConfigPatch,
  FsDirsResponse,
  LoginResponse,
  Profile,
  ProfileSettings,
  Project,
  ProjectDetail,
  ProjectStateResponse,
  RepoWithOrphans,
  Session,
  UiStateSnapshot,
} from '@puddle/shared';
import { api } from './api';
import { clientId } from './client-id';

/** TanStack Query hooks per daemon resource. Types come from @puddle/shared. */

export function useProfiles() {
  return useQuery({
    queryKey: ['profiles'],
    queryFn: () => api<Profile[]>('GET', '/api/profiles'),
  });
}

export function useProfileSettings(profileId: number | undefined) {
  return useQuery({
    queryKey: ['profile-settings', profileId],
    queryFn: () => api<ProfileSettings>('GET', `/api/profiles/${profileId}/settings`),
    enabled: profileId !== undefined,
  });
}

export function useAccounts(profileId: number | undefined) {
  return useQuery({
    queryKey: ['accounts', profileId],
    queryFn: () => api<Account[]>('GET', `/api/accounts?profile=${profileId}`),
    enabled: profileId !== undefined,
  });
}

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: () => api<RepoWithOrphans[]>('GET', '/api/repos'),
  });
}

/** All projects when profileId is undefined (the "everyone" view). */
export function useProjects(profileId: number | undefined) {
  return useQuery({
    queryKey: ['projects', profileId ?? 'all'],
    queryFn: () =>
      api<Project[]>(
        'GET',
        profileId === undefined ? '/api/projects' : `/api/projects?profile=${profileId}`,
      ),
  });
}

export function useProjectDetail(projectId: number | undefined) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetail>('GET', `/api/projects/${projectId}`),
    enabled: projectId !== undefined,
  });
}

export function useSessions(projectId: number | undefined) {
  return useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => api<Session[]>('GET', `/api/sessions?project=${projectId}`),
    enabled: projectId !== undefined,
  });
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => api<DaemonConfig>('GET', '/api/config') });
}

export function useDirSuggestions(prefix: string) {
  return useQuery({
    queryKey: ['fs-dirs', prefix],
    queryFn: () => api<FsDirsResponse>('GET', `/api/fs/dirs?prefix=${encodeURIComponent(prefix)}`),
    enabled: prefix.startsWith('/') || prefix.startsWith('~'), // ~ expands on the host
    placeholderData: (previous) => previous, // keep the list steady while typing
    staleTime: 10_000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api<AgentType[]>('GET', '/api/agents'),
    staleTime: Infinity, // the adapter set changes only with a daemon upgrade
  });
}

/* -- Mutations ---------------------------------------------------------- */

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; branch_prefix?: string }) =>
      api<Profile>('POST', '/api/profiles', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profiles'] }),
  });
}

export function usePatchProfileSettings(profileId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<ProfileSettings>('PATCH', `/api/profiles/${profileId}/settings`, patch),
    onSuccess: (settings) => qc.setQueryData(['profile-settings', profileId], settings),
  });
}

export function usePatchProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, branch_prefix }: { id: number; branch_prefix: string }) =>
      api<Profile>('PATCH', `/api/profiles/${id}`, { branch_prefix }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profiles'] }),
  });
}

export function usePatchAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      skip_permissions_default,
    }: {
      id: number;
      skip_permissions_default: boolean;
    }) => api<Account>('PATCH', `/api/accounts/${id}`, { skip_permissions_default }),
    onSuccess: (account) =>
      void qc.invalidateQueries({ queryKey: ['accounts', account.profile_id] }),
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>('DELETE', `/api/profiles/${id}`),
    onSuccess: () => qc.clear(), // everything under the profile is gone
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>('DELETE', `/api/accounts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      profile_id: number;
      agent_type: string;
      label: string;
      skip_permissions_default?: boolean;
    }) => api<Account>('POST', '/api/accounts', body),
    onSuccess: (account) =>
      void qc.invalidateQueries({ queryKey: ['accounts', account.profile_id] }),
  });
}

export function useLoginAccount() {
  return useMutation({
    mutationFn: (accountId: number) =>
      api<LoginResponse>('POST', `/api/accounts/${accountId}/login`),
  });
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; default_base_branch?: string; onboarding_notes?: string }) =>
      api<RepoWithOrphans>('POST', '/api/repos', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function usePatchRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api<RepoWithOrphans>('PATCH', `/api/repos/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useFetchRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: number) => api<RepoWithOrphans>('POST', `/api/repos/${repoId}/fetch`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { profile_id: number; repo_id: number; name: string }) =>
      api<Project>('POST', '/api/projects', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

function invalidateSessions(qc: ReturnType<typeof useQueryClient>, session: Session) {
  void qc.invalidateQueries({ queryKey: ['sessions', session.project_id] });
  void qc.invalidateQueries({ queryKey: ['project', session.project_id] });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSessionRequest) => api<Session>('POST', '/api/sessions', body),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function useSessionAction(action: 'resume' | 'kill') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api<Session>('POST', `/api/sessions/${sessionId}/${action}`),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, force }: { sessionId: string; force?: boolean }) =>
      api<Session>('POST', `/api/sessions/${sessionId}/archive`, { force: force ?? false }),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function useRenameSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api<Session>('PATCH', `/api/sessions/${sessionId}`, { title }),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function usePatchConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: DaemonConfigPatch) => api<DaemonConfig>('PATCH', '/api/config', patch),
    onSuccess: (config) => qc.setQueryData(['config'], config),
  });
}

/* -- Workspace ui_state (SPEC §11 reload semantics) ---------------------- */

export async function fetchProjectState(projectId: number): Promise<ProjectStateResponse | null> {
  try {
    return await api<ProjectStateResponse>(
      'GET',
      `/api/projects/${projectId}/state?client=${clientId()}`,
    );
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'no_state') return null;
    throw e;
  }
}

export function putProjectState(
  projectId: number,
  uiState: UiStateSnapshot,
): Promise<ProjectStateResponse> {
  return api<ProjectStateResponse>('PUT', `/api/projects/${projectId}/state?client=${clientId()}`, {
    ui_state: uiState,
  });
}
