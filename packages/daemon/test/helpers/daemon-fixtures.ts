import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '@puddle/shared';
import type { AgentAdapter } from '../../src/agents/adapter.js';
import { AdapterRegistry } from '../../src/agents/registry.js';
import { openDatabase } from '../../src/db/db.js';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { EventStore } from '../../src/db/stores/events.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RemovalStore } from '../../src/db/stores/removals.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { KeyedMutex } from '../../src/git/mutex.js';
import { LogStore } from '../../src/logs/log-store.js';
import { ensureHome, resolvePaths } from '../../src/paths.js';
import { PortScanner } from '../../src/ports/scanner.js';
import { PtyManager } from '../../src/pty/pty-manager.js';
import { ConversationShare } from '../../src/sessions/conversation-share.js';
import { MarkerFileSync } from '../../src/sessions/onboarding.js';
import { SessionService } from '../../src/sessions/service.js';
import { WorktreeManager } from '../../src/worktrees/manager.js';
import { initRepo } from './git-fixtures.js';

/** Stable store-key from a worktree path (mirrors claude's escaped-cwd dir). */
function fakeStoreKey(worktreePath: string): string {
  let h = 5381;
  for (let i = 0; i < worktreePath.length; i++) h = ((h << 5) + h + worktreePath.charCodeAt(i)) | 0;
  return `fake-${(h >>> 0).toString(16)}`;
}

/**
 * A deterministic agent for tests: bash echoing its launch/resume arguments,
 * then `cat`-ing stdin back. READY lines drive the waiting_input detector.
 *
 * With `{ share: true }` the agent also writes a real conversation store —
 * `<config>/projects/<key>/<ref>.jsonl` plus `<config>/todos/<ref>.json` — and
 * gains the conversationShare hooks, so the adoption/mirror/archive paths are
 * exercisable without a real claude. The default (no options) is unchanged so
 * the rest of the suite keeps its simple marker-based conversation model.
 */
export function fakeAdapter(opts: { share?: boolean } = {}): AgentAdapter {
  const base: AgentAdapter = {
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
    // A usage.json marker lets tests assert the token passthrough.
    usageStats: (account) => {
      const file = join(account.config_dir, 'usage.json');
      return existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as ReturnType<
            NonNullable<AgentAdapter['usageStats']>
          >)
        : null;
    },
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
    resolveSessionRef: async (o, account) => {
      const ref = `fake-ref-${o.sessionId}`;
      // A marker per conversation makes hasConversation truthful for tests.
      writeFileSync(join(account.config_dir, `conv-${ref}`), '');
      return ref;
    },
    hasConversation: (ref, account) => existsSync(join(account.config_dir, `conv-${ref}`)),
    discoverSessionRef: (_worktreePath, account) => {
      const file = join(account.config_dir, 'discovered-ref');
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    },
    statusPatterns: { waitingInput: [/READY/], busy: [/BUSY-MARKER/] },
  };
  if (!opts.share) return base;

  // A bash script writing a real per-conversation store dir; the trailing
  // `read` loop appends PTY input to the JSONL so adoption's moved-inode
  // property (canonical file grows through the symlink) is observable.
  const launch = [
    'd="$FAKE_CONFIG_DIR/projects/$2"',
    'mkdir -p "$d" "$FAKE_CONFIG_DIR/todos"',
    'printf \'{"cwd":"%s"}\\n\' "$PWD" > "$d/$3.jsonl"',
    'printf \'[]\' > "$FAKE_CONFIG_DIR/todos/$3.json"',
    'echo "LAUNCH skip=$1"',
    'echo READY',
    'while IFS= read -r l; do printf \'%s\\n\' "$l" >> "$d/$3.jsonl"; done',
  ].join('; ');
  const resume = [
    'd="$FAKE_CONFIG_DIR/projects/$3"',
    'mkdir -p "$d" "$FAKE_CONFIG_DIR/todos"',
    'echo "RESUME ref=$1 skip=$2"',
    'echo READY',
    'while IFS= read -r l; do printf \'%s\\n\' "$l" >> "$d/$1.jsonl"; done',
  ].join('; ');
  const projectsScan = (ref: string, account: Account): string | null => {
    const projects = join(account.config_dir, 'projects');
    if (!existsSync(projects)) return null;
    for (const dir of readdirSync(projects)) {
      if (existsSync(join(projects, dir, `${ref}.jsonl`))) return join(projects, dir);
    }
    return null;
  };
  return {
    ...base,
    launchArgs: (o) => [
      '-c',
      launch,
      'bash',
      String(o.skipPermissions),
      fakeStoreKey(o.worktreePath),
      `fake-ref-${o.sessionId}`,
    ],
    resumeArgs: (ref, o) => [
      '-c',
      resume,
      'bash',
      ref,
      String(o.skipPermissions),
      fakeStoreKey(o.worktreePath),
    ],
    // The JSONL is the source of truth here — no separate conv marker.
    resolveSessionRef: async (o) => `fake-ref-${o.sessionId}`,
    hasConversation: (ref, account) => projectsScan(ref, account) !== null,
    conversationShare: {
      storeParent: (account) => join(account.config_dir, 'projects'),
      locateStoreDir: (ref, account) => projectsScan(ref, account),
      sessionFiles: (ref, storeDir, account) => ({
        inStore: [join(storeDir, `${ref}.jsonl`)],
        perAccount: [join(account.config_dir, 'todos', `${ref}.json`)],
      }),
    },
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
    removals: RemovalStore;
  };
  logs: LogStore;
  ptys: PtyManager;
  scanner: PortScanner;
  worktrees: WorktreeManager;
  service: SessionService;
  share: ConversationShare;
  adapters: AdapterRegistry;
  onboarding: MarkerFileSync;
  ids: { profile: string; account: number; repo: number; project: string };
  repoPath: string;
}

/** Full daemon wiring (minus HTTP/WS) on a temp home with a real git repo. */
export function fixture(opts: { quietMs?: number; share?: boolean } = {}): Fixture {
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
    removals: new RemovalStore(db),
  };
  const logs = new LogStore(paths.logsDir, 256 * 1024);
  const ptys = new PtyManager(logs);
  const scanner = new PortScanner({ ptys });
  const worktrees = new WorktreeManager({
    paths,
    mutex: new KeyedMutex(),
    repos: stores.repos,
    sessions: stores.sessions,
  });
  const onboarding = new MarkerFileSync({
    repos: stores.repos,
    events: stores.events,
    sessions: stores.sessions,
  });
  const adapters = new AdapterRegistry([fakeAdapter({ share: opts.share })]);
  const share = new ConversationShare({
    accounts: stores.accounts,
    adapters,
    paths,
    mutex: new KeyedMutex(),
    events: stores.events,
  });
  const service = new SessionService({
    ...stores,
    worktrees,
    ptys,
    adapters,
    logs,
    onboarding,
    share,
    statusQuietMs: opts.quietMs ?? 150,
  });

  const repoPath = initRepo();
  const profile = stores.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
  const configDir = paths.accountConfigDir(profile.id, 'fake', 'personal');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'creds.json'), '{}'); // fake adapter's logged-in marker
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
    scanner,
    worktrees,
    service,
    share,
    adapters,
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
