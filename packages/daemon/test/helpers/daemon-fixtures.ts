import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../../src/agents/adapter.js';
import { AdapterRegistry } from '../../src/agents/registry.js';
import { openDatabase } from '../../src/db/db.js';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { EventStore } from '../../src/db/stores/events.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { KeyedMutex } from '../../src/git/mutex.js';
import { LogStore } from '../../src/logs/log-store.js';
import { ensureHome, resolvePaths } from '../../src/paths.js';
import { PtyManager } from '../../src/pty/pty-manager.js';
import { OnboardingNotesSync } from '../../src/sessions/onboarding.js';
import { SessionService } from '../../src/sessions/service.js';
import { WorktreeManager } from '../../src/worktrees/manager.js';
import { initRepo } from './git-fixtures.js';

/**
 * A deterministic agent for tests: bash echoing its launch/resume arguments,
 * then `cat`-ing stdin back. READY lines drive the waiting_input detector.
 */
export function fakeAdapter(): AgentAdapter {
  return {
    id: 'fake',
    displayName: 'Fake Agent',
    binary: 'bash',
    capabilities: {
      resume: true,
      presetSessionId: true,
      skipPermissions: true,
      migratableSessions: false,
    },
    env: (account) => ({ FAKE_CONFIG_DIR: account.config_dir }),
    importConfigDir: async (sourceDir, configDir) => {
      await cp(sourceDir, configDir, { recursive: true });
    },
    // "Credentials" are a marker file — lets tests exercise both outcomes.
    checkLoggedIn: async (account) => existsSync(join(account.config_dir, 'creds.json')),
    launchArgs: (o) => [
      '-c',
      'echo "LAUNCH skip=$1"; echo "PROMPT<<$2>>"; echo READY; cat',
      'bash',
      String(o.skipPermissions),
      o.prompt ?? '',
    ],
    resumeArgs: (ref, o) => [
      '-c',
      'echo "RESUME ref=$1 skip=$2"; echo "PROMPT<<$3>>"; echo READY; cat',
      'bash',
      ref,
      String(o.skipPermissions),
      o.prompt ?? '',
    ],
    loginArgs: () => ['-c', 'echo LOGIN-OK'],
    resolveSessionRef: async (o) => `fake-ref-${o.sessionId}`,
    statusPatterns: { waitingInput: [/READY/], busy: [/BUSY-MARKER/] },
  };
}

export interface Fixture {
  paths: ReturnType<typeof resolvePaths>;
  stores: {
    profiles: ProfileStore;
    accounts: AccountStore;
    repos: RepoStore;
    projects: ProjectStore;
    sessions: SessionStore;
    events: EventStore;
  };
  logs: LogStore;
  ptys: PtyManager;
  service: SessionService;
  onboarding: OnboardingNotesSync;
  ids: { profile: number; account: number; repo: number; project: number };
  repoPath: string;
}

/** Full daemon wiring (minus HTTP/WS) on a temp home with a real git repo. */
export function fixture(opts: { quietMs?: number } = {}): Fixture {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-home-')));
  ensureHome(paths);
  const db = openDatabase(paths.dbFile);
  const stores = {
    profiles: new ProfileStore(db),
    accounts: new AccountStore(db),
    repos: new RepoStore(db),
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    events: new EventStore(db),
  };
  const logs = new LogStore(paths.logsDir, 256 * 1024);
  const ptys = new PtyManager(logs);
  const worktrees = new WorktreeManager({
    paths,
    mutex: new KeyedMutex(),
    repos: stores.repos,
    sessions: stores.sessions,
  });
  const onboarding = new OnboardingNotesSync({ repos: stores.repos, events: stores.events });
  const adapters = new AdapterRegistry([fakeAdapter()]);
  const service = new SessionService({
    ...stores,
    worktrees,
    ptys,
    adapters,
    logs,
    onboarding,
    statusQuietMs: opts.quietMs ?? 150,
  });

  const repoPath = initRepo();
  const profile = stores.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
  const configDir = paths.accountConfigDir('alice', 'fake', 'personal');
  mkdirSync(configDir, { recursive: true });
  const account = stores.accounts.create({
    profile_id: profile.id,
    agent_type: 'fake',
    label: 'personal',
    config_dir: configDir,
    skip_permissions_default: false,
  });
  const repo = stores.repos.create({
    path: repoPath,
    default_base_branch: 'main',
    onboarding_notes: 'always run make setup',
    fetch_enabled: true,
  });
  const project = stores.projects.create({
    profile_id: profile.id,
    repo_id: repo.id,
    name: 'demo',
  });
  return {
    paths,
    stores,
    logs,
    ptys,
    service,
    onboarding,
    repoPath,
    ids: { profile: profile.id, account: account.id, repo: repo.id, project: project.id },
  };
}

export async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
