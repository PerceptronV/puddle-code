import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HuddleSessionFeedScope } from '@puddle/shared';
import { openDatabase } from '../../../src/db/db.js';
import { ProfileStore } from '../../../src/db/stores/profiles.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { RepoStore } from '../../../src/db/stores/repos.js';
import { SessionStore } from '../../../src/db/stores/sessions.js';
import { EventStore } from '../../../src/db/stores/events.js';
import { HuddleSessionFeed } from '../../../src/huddle/triggers/sessions/feed.js';

export function sessionFeedFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-session-feed-'))),
    file = join(home, 'db.sqlite');
  const db = openDatabase(file),
    sessions = new SessionStore(db),
    events = new EventStore(db);
  const profile = new ProfileStore(db).create({ name: 'fixture', branch_prefix: '' });
  const repo = new RepoStore(db).create({
    path: home,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const projects = new ProjectStore(db);
  const project = projects.create({ profile_id: profile.id, repo_id: repo.id, name: 'fixture' });
  const create = (projectId = project.id, worktree = home) =>
    sessions.create({
      id: randomUUID(),
      project_id: projectId,
      account_id: null,
      worktree_path: worktree,
      base_branch: 'main',
      branch: 'main',
      separate_branch: false,
      kind: 'terminal',
      agent_type: null,
      title: null,
      skip_permissions: false,
    });
  const session = create(),
    feed = new HuddleSessionFeed(db);
  const scope: HuddleSessionFeedScope = {
    profileId: profile.id,
    projectId: project.id,
    worktree: home,
    kinds: ['agent', 'terminal', 'huddle'],
    events: [
      'created',
      'resumed',
      'interrupted',
      'exited',
      'killed',
      'archived',
      'unarchived',
      'spawn_failed',
      'status',
    ],
  };
  return {
    home,
    file,
    db,
    profile,
    repo,
    project,
    projects,
    sessions,
    events,
    session,
    create,
    feed,
    scope,
    cleanup() {
      if (db.open) db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
