import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RepoStore } from '../../src/db/stores/repos.js';
import { MarkerFileSync } from '../../src/sessions/onboarding.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';

it('resynchronises current marker contents after maintenance and never revives disposed watchers', async () => {
  const f = runtimeDatabase();
  const repos = new RepoStore(f.db);
  const markers = new MarkerFileSync({ repos, events: f.events, sessions: f.sessions });
  const directory = join(f.home, '.puddle');
  mkdirSync(directory);
  const path = join(directory, 'onboarding-notes.md');
  try {
    markers.watch(f.session.id, f.project.repo_id, f.home);
    writeFileSync(path, 'before maintenance');
    const hold = markers.pause();
    await hold.drain();
    writeFileSync(path, 'latest notes');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(repos.get(f.project.repo_id).onboarding_notes).toBeNull();
    hold.release();
    await vi.waitFor(() =>
      expect(repos.get(f.project.repo_id).onboarding_notes).toBe('latest notes'),
    );
    expect(
      f.events.list(f.session.id).filter((event) => event.type === 'onboarding_notes_updated'),
    ).toHaveLength(1);
    const shutdown = markers.pause();
    markers.dispose();
    shutdown.release();
    writeFileSync(path, 'after shutdown');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(repos.get(f.project.repo_id).onboarding_notes).toBe('latest notes');
  } finally {
    markers.dispose();
    await f.reconciler.close();
    f.db.close();
  }
});
