import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Account,
  AccountUsage,
  AgentType,
  CreateSessionRequest,
  DaemonConfig,
  DaemonConfigPatch,
  FsDirsResponse,
  HostInfo,
  LoginResponse,
  Profile,
  ProfileSettings,
  Project,
  ProjectDetail,
  ProjectStateResponse,
  RepoBranchesResponse,
  RepoWithOrphans,
  RepoWorktreesResponse,
  Session,
  SessionPortsResponse,
  UiStateSnapshot,
} from '@puddle/shared';
import { api } from './api';

/** TanStack Query hooks per daemon resource. Types come from @puddle/shared. */

export function useProfiles() {
  return useQuery({
    queryKey: ['profiles'],
    queryFn: () => api<Profile[]>('GET', '/api/profiles'),
  });
}

export function useProfileSettings(profileId: string | undefined) {
  return useQuery({
    queryKey: ['profile-settings', profileId],
    queryFn: () => api<ProfileSettings>('GET', `/api/profiles/${profileId}/settings`),
    enabled: profileId !== undefined,
  });
}

export function useAccounts(profileId: string | undefined) {
  return useQuery({
    queryKey: ['accounts', profileId],
    queryFn: () => api<Account[]>('GET', `/api/accounts?profile=${profileId}`),
    enabled: profileId !== undefined,
  });
}

export function useAccountUsage(accountId: number | undefined) {
  return useQuery({
    queryKey: ['account-usage', accountId],
    queryFn: () => api<AccountUsage>('GET', `/api/accounts/${accountId}/usage`),
    enabled: accountId !== undefined,
    staleTime: 15_000,
  });
}

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: () => api<RepoWithOrphans[]>('GET', '/api/repos'),
  });
}

/** All projects when profileId is undefined (the "everyone" view). */
export function useProjects(profileId: string | undefined) {
  return useQuery({
    queryKey: ['projects', profileId ?? 'all'],
    queryFn: () =>
      api<Project[]>(
        'GET',
        profileId === undefined ? '/api/projects' : `/api/projects?profile=${profileId}`,
      ),
  });
}

export function useProjectDetail(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetail>('GET', `/api/projects/${projectId}`),
    enabled: projectId !== undefined,
  });
}

export function useSessions(projectId: string | undefined) {
  return useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => api<Session[]>('GET', `/api/sessions?project=${projectId}`),
    enabled: projectId !== undefined,
  });
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => api<DaemonConfig>('GET', '/api/config') });
}

export function useRepoBranches(repoId: number | undefined) {
  return useQuery({
    queryKey: ['repo-branches', repoId],
    queryFn: () => api<RepoBranchesResponse>('GET', `/api/repos/${repoId}/branches`),
    enabled: repoId !== undefined,
    staleTime: 30_000,
  });
}

/** Every git worktree currently checked out for a repo (SPEC §4, join_worktree). */
export function useRepoWorktrees(repoId: number | undefined) {
  return useQuery({
    queryKey: ['repo-worktrees', repoId],
    queryFn: () => api<RepoWorktreesResponse>('GET', `/api/repos/${repoId}/worktrees`),
    enabled: repoId !== undefined,
    staleTime: 10_000,
  });
}

/**
 * Prune (remove) a worktree of a repo (SPEC §8). The branch is kept, so there
 * is no confirmation. Refreshes the worktree list and the project (a session
 * may now be "worktree missing").
 */
export function usePruneWorktree(repoId: number | undefined, projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) =>
      api<RepoWorktreesResponse>(
        'DELETE',
        `/api/repos/${repoId}/worktrees?path=${encodeURIComponent(path)}`,
      ),
    onSuccess: (res) => {
      qc.setQueryData(['repo-worktrees', repoId], res);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

/**
 * Delete an orphaned local branch of a repo (SPEC §8): only branches with no
 * worktree; `confirm` is required by the daemon for a purely-local branch
 * (deleting it discards unpushed commits).
 */
export function useDeleteBranch(repoId: number | undefined, projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, confirm }: { name: string; confirm?: boolean }) => {
      const qs = new URLSearchParams({ name });
      if (confirm) qs.set('confirm', '1');
      return api<RepoWorktreesResponse>('DELETE', `/api/repos/${repoId}/branches?${qs.toString()}`);
    },
    onSuccess: (res) => {
      qc.setQueryData(['repo-worktrees', repoId], res);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
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

export function useHostInfo() {
  return useQuery({
    queryKey: ['host'],
    queryFn: () => api<HostInfo>('GET', '/api/host'),
    staleTime: Infinity, // the box does not change under a running daemon
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

export function usePatchProfileSettings(profileId: string) {
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
    mutationFn: ({ id, branch_prefix }: { id: string; branch_prefix: string }) =>
      api<Profile>('PATCH', `/api/profiles/${id}`, { branch_prefix }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profiles'] }),
  });
}

export function usePatchAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: number;
      label?: string;
      skip_permissions_default?: boolean;
    }) => api<Account>('PATCH', `/api/accounts/${id}`, patch),
    onSuccess: (account) => {
      void qc.invalidateQueries({ queryKey: ['accounts', account.profile_id] });
      void qc.invalidateQueries({ queryKey: ['account-usage', account.id] });
    },
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>('DELETE', `/api/profiles/${id}`),
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
      profile_id: string;
      agent_type: string;
      label: string;
      skip_permissions_default?: boolean;
      import_dir?: string;
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
    mutationFn: (body: { profile_id: string; repo_id: number; name: string }) =>
      api<Project>('POST', '/api/projects', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/** Rename and/or archive a project (archive is a reversible hide, SPEC §11). */
export function usePatchProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; archived?: boolean }) =>
      api<Project>('PATCH', `/api/projects/${id}`, patch),
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

/**
 * Tier-1 migration (SPEC §5/§6): move a session to another account of the same
 * (profile, agent) and resume it there. The conversation stays in the shared
 * store, so this only repoints `account_id` and resumes under the target.
 */
export function useMigrateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, accountId }: { sessionId: string; accountId: number }) =>
      api<Session>('POST', `/api/sessions/${sessionId}/migrate`, { account_id: accountId }),
    onSuccess: (session) => invalidateSessions(qc, session),
  });
}

export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      force,
      deleteBranch,
    }: {
      sessionId: string;
      force?: boolean;
      deleteBranch?: boolean;
    }) =>
      api<Session>('POST', `/api/sessions/${sessionId}/archive`, {
        force: force ?? false,
        delete_branch: deleteBranch ?? false,
      }),
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

export async function fetchProjectState(
  projectId: string,
  profileId: string,
): Promise<ProjectStateResponse | null> {
  try {
    return await api<ProjectStateResponse>(
      'GET',
      `/api/projects/${projectId}/state?profile=${profileId}`,
    );
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'no_state') return null;
    throw e;
  }
}

export function putProjectState(
  projectId: string,
  profileId: string,
  uiState: UiStateSnapshot,
): Promise<ProjectStateResponse> {
  return api<ProjectStateResponse>('PUT', `/api/projects/${projectId}/state?profile=${profileId}`, {
    ui_state: uiState,
  });
}

/**
 * Ports strip (SPEC §9): polls only while `live` (the active session is
 * `running`/`waiting_input`) — no refresh button, the 5s interval IS the
 * refresh, and background tabs stop polling entirely.
 */
export function useSessionPorts(sessionId: string | undefined, live: boolean) {
  return useQuery({
    queryKey: ['ports', sessionId],
    queryFn: () => api<SessionPortsResponse>('GET', `/api/sessions/${sessionId}/ports`),
    enabled: sessionId !== undefined && live,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}
