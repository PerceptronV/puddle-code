import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Every filesystem location the daemon touches, derived from one home dir. */
export interface PuddlePaths {
  home: string;
  dbFile: string;
  tokenFile: string;
  configFile: string;
  /** Records where the daemon actually bound, so clients discover the live port. */
  runtimeFile: string;
  profilesDir: string;
  worktreesDir: string;
  logsDir: string;
  accountConfigDir(profileId: string, agentType: string, label: string): string;
  /**
   * Per-profile canonical store for adopted agent conversations (Workstream S).
   * A conversation's project dir is renamed here once and symlinked back into
   * every account of the (profile, agent) so the same agent can resume it under
   * a different account without moving files.
   */
  profileSessionsDir(profileId: string, agentType: string): string;
  sessionWorktreeDir(repoId: number, sessionId: string): string;
  /** Shared per-(repo, branch) worktree for separate_branch = false sessions (SPEC §4). */
  sharedWorktreeDir(repoId: number, branchSlug: string): string;
  sessionLogDir(sessionId: string): string;
}

export function resolvePaths(
  home: string = process.env.PUDDLE_HOME ?? join(homedir(), '.puddle'),
): PuddlePaths {
  return {
    home,
    dbFile: join(home, 'puddle.db'),
    tokenFile: join(home, 'token'),
    configFile: join(home, 'config.json'),
    runtimeFile: join(home, 'runtime.json'),
    profilesDir: join(home, 'profiles'),
    worktreesDir: join(home, 'worktrees'),
    logsDir: join(home, 'logs'),
    accountConfigDir: (profileId, agentType, label) =>
      join(home, 'profiles', profileId, 'accounts', agentType, label),
    profileSessionsDir: (profileId, agentType) =>
      join(home, 'profiles', profileId, 'sessions', agentType),
    sessionWorktreeDir: (repoId, sessionId) => join(home, 'worktrees', String(repoId), sessionId),
    sharedWorktreeDir: (repoId, branchSlug) =>
      join(home, 'worktrees', String(repoId), `branch-${branchSlug}`),
    sessionLogDir: (sessionId) => join(home, 'logs', sessionId),
  };
}

export function ensureHome(paths: PuddlePaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.profilesDir, { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
}
