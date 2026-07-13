import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Every filesystem location the daemon touches, derived from one home dir. */
export interface PuddlePaths {
  home: string;
  dbFile: string;
  tokenFile: string;
  configFile: string;
  profilesDir: string;
  worktreesDir: string;
  logsDir: string;
  accountConfigDir(profileName: string, agentType: string, label: string): string;
  sessionWorktreeDir(repoId: number, sessionId: string): string;
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
    profilesDir: join(home, 'profiles'),
    worktreesDir: join(home, 'worktrees'),
    logsDir: join(home, 'logs'),
    accountConfigDir: (profileName, agentType, label) =>
      join(home, 'profiles', profileName, 'accounts', agentType, label),
    sessionWorktreeDir: (repoId, sessionId) => join(home, 'worktrees', String(repoId), sessionId),
    sessionLogDir: (sessionId) => join(home, 'logs', sessionId),
  };
}

export function ensureHome(paths: PuddlePaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.profilesDir, { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
}
