import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { openDatabase } from '../../src/db/db.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { ConversationStore } from '../../src/db/stores/conversations.js';
import { EventStore } from '../../src/db/stores/events.js';
import { RuntimeStore } from '../../src/db/stores/runtimes.js';
import { RuntimeReconciler } from '../../src/runtime/controller/reconcile.js';
import { ensureHome, resolvePaths } from '../../src/paths.js';
import { prepare } from './runtime-fixture.js';

export function runtimeDatabase(mode?: 'interactive' | 'headless') {
  const fixture = prepare(mode);
  const { home, launch, directory } = fixture;
  const paths = resolvePaths(home);
  ensureHome(paths);
  const db = openDatabase(paths.dbFile);
  const profiles = new ProfileStore(db);
  const profile = profiles.create({ name: 'runtime-events', branch_prefix: '' });
  const repo = new RepoStore(db).create({
    path: home,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const project = new ProjectStore(db).create({
    profile_id: profile.id,
    repo_id: repo.id,
    name: 'runtime-events',
  });
  const account = mode
    ? new AccountStore(db).create({
        profile_id: profile.id,
        agent_type: 'runtime-test',
        label: 'fixture',
        config_dir: home,
        skip_permissions_default: false,
      })
    : null;
  const sessions = new SessionStore(db);
  const conversations = new ConversationStore(db);
  const events = new EventStore(db);
  const session = sessions.create({
    id: randomUUID(),
    project_id: project.id,
    account_id: account?.id ?? null,
    worktree_path: home,
    base_branch: 'main',
    branch: 'main',
    separate_branch: false,
    branch_owned: true,
    kind: mode ? 'agent' : 'terminal',
    agent_type: mode ? 'runtime-test' : null,
    agent_mode: mode ?? 'interactive',
    title: null,
    skip_permissions: false,
  });
  Object.assign(launch.identity, {
    profile_id: profile.id,
    project_id: project.id,
    session_id: session.id,
    canonical_worktree_path: realpathSync(home),
  });
  launch.capture_env = { enabled: true, values: { INITIAL: 'seed' } };
  atomicPrivateJson(join(directory, 'launch.json'), launch);
  const runtimes = new RuntimeStore(db);
  const binding = runtimes.prepare({
    identity: launch.identity,
    build: 'runtime-test',
    protocol: RUNTIME_PROTOCOL_VERSION,
    releasePath: directory,
  });
  const reconciler = new RuntimeReconciler({ home, db, runtimes, sessions, conversations, events });
  return {
    ...fixture,
    db,
    paths,
    profiles,
    profile,
    project,
    account,
    session,
    sessions,
    conversations,
    events,
    runtimes,
    binding,
    reconciler,
  };
}
