import { expect, it, onTestFinished, vi } from 'vitest';
import { openDatabase } from '../../../src/db/db.js';
import { RuntimeStore } from '../../../src/db/stores/runtimes.js';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { fixture } from '../../helpers/daemon-fixtures.js';
import { reconcilePass } from '../../../src/sessions/reconcile.js';

it('keeps huddles out of ordinary launch, shell and runtime-restart paths', async () => {
  const f = fixture();
  const db = openDatabase(f.paths.dbFile);
  onTestFinished(() => db.close());
  const session = new HuddlePlacements(db).open({
    projectId: f.ids.project,
    worktree: f.repoPath,
    huddleId: 'a'.repeat(32),
    branch: 'main',
    title: 'Huddle',
  }).session;
  const watch = vi.spyOn(f.onboarding, 'watch');
  for (const action of [
    () => f.service.resume(session.id),
    () => f.service.spawnShell(session.id),
    () => f.service.kill(session.id),
    () => f.service.inspectRuntime(session.id, () => true),
    () => f.service.restartRuntime(session.id, { fingerprint: 'unreviewed' }, () => true),
  ]) {
    await expect(action()).rejects.toMatchObject({ code: 'huddle_control_required' });
    expect(f.stores.sessions.get(session.id).status).toBe('exited');
    expect(f.ptys.liveTerms(session.id)).toEqual([]);
    expect(new RuntimeStore(db).ownerOf(session.id)).toBeNull();
  }
  await f.service.archive(session.id);
  expect(f.stores.sessions.get(session.id).status).toBe('archived');
  await f.service.unarchive(session.id);
  expect(f.stores.sessions.get(session.id).status).toBe('exited');
  f.stores.sessions.setStatus(session.id, 'running');
  const boot = reconcilePass({
    ...f.stores,
    onboarding: f.onboarding,
    runtimes: new RuntimeStore(db),
  });
  expect(boot.interrupted).not.toContain(session.id);
  expect(f.stores.sessions.get(session.id).status).toBe('interrupted');
  expect(watch).not.toHaveBeenCalled();
});
